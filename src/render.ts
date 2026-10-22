import { type Geo, buildGeo, densify, roadOutlinePoly, widthsAt } from './geo';
import { ARROW_VARIANTS, MARKING_BY_ID, type MarkingSpec } from './markings';
import { VALUE_SIGNS, markingFile, signFile } from './signs';
import { imgUrl } from './corpus';
import { type Vec, add, angleOf, frameAtStation, fromAngle, kmh, mul, norm, rightOf, sub } from './geom';
import type { Report } from './analysis';
import {
  type Actor,
  type Scene,
  type Sign,
  type TrafficLight,
  GAUGE,
  PEDESTRIANS,
  VEHICLES,
  actorLabels,
  actorSpec,
  lightPhase,
  pedestrianGreen,
} from './scene';
import type { PedestrianType, VehicleType } from './scene';
import type { Timeline } from './sim';
import { DT } from './sim';
import { vehicleSignalAt } from './maneuver-signals';
import { effectiveRouteLaneStations } from './analysis/route-transport';

export interface Camera {
  x: number;
  y: number;
  /** пикселей на метр */
  s: number;
}

export interface Selection {
  col: 'roads' | 'sidewalks' | 'tracks' | 'crosswalks' | 'lights' | 'signs' | 'markings' | 'obstacles' | 'actors';
  id: string;
}

export interface DrawingState {
  tool: string;
  pts: Vec[];
  cursor: Vec | null;
}

export interface GhostState {
  tool: string;
  kind: string;
  at: Vec;
  angle: number;
}

const POLY = ['road', 'sidewalk', 'track'];

export interface ViewState {
  /** настройки кисти (для предпросмотра сглаживания) */
  brush?: { smooth: boolean; radius: number };
  scene: Scene;
  cam: Camera;
  mode: 'edit' | 'play';
  t: number;
  tl: Timeline | null;
  report: Report | null;
  sel: Selection | null;
  selWp: number | null;
  drawing: DrawingState | null;
  pathActor: string | null;
  ghost: GhostState | null;
  grid: boolean;
  /** подсвечиваемый участник (из разбора) */
  focus: string | null;
}

const C = {
  grass: '#1b2a22',
  grassGrid: 'rgba(255,255,255,0.05)',
  asphalt: '#3a3f47',
  sidewalk: '#8b929c',
  mark: '#f2f4f8',
  rail: '#a8b0ba',
  sleeper: '#6b5a48',
  sel: '#ffd166',
};

export function worldToScreen(cam: Camera, w: number, h: number, p: Vec): Vec {
  return { x: (p.x - cam.x) * cam.s + w / 2, y: (p.y - cam.y) * cam.s + h / 2 };
}

export function screenToWorld(cam: Camera, w: number, h: number, p: Vec): Vec {
  return { x: (p.x - w / 2) / cam.s + cam.x, y: (p.y - h / 2) / cam.s + cam.y };
}

/** Смещение ломаной вправо по ходу на d метров (отрицательное — влево). */
export function offsetPolyline(pts: Vec[], d: number): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = i > 0 ? norm(sub(pts[i], pts[i - 1])) : null;
    const next = i < pts.length - 1 ? norm(sub(pts[i + 1], pts[i])) : null;
    const t1 = prev ?? next!;
    const t2 = next ?? prev!;
    const r1 = rightOf(angleOf(t1));
    const r2 = rightOf(angleOf(t2));
    let n = { x: r1.x + r2.x, y: r1.y + r2.y };
    const l = Math.hypot(n.x, n.y);
    if (l < 1e-6) n = r1;
    else {
      // длина смещения по биссектрисе: d / cos(θ/2), ограничена
      const cos = Math.max(0.35, l / 2);
      n = { x: n.x / l / cos, y: n.y / l / cos };
    }
    out.push({ x: pts[i].x + n.x * d, y: pts[i].y + n.y * d });
  }
  return out;
}

function tracePath(ctx: CanvasRenderingContext2D, pts: Vec[], close = false): void {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  if (close) ctx.closePath();
}

/** Кэш картинок знаков и разметки; после загрузки просит перерисовать холст. */
class ImageCache {
  private map = new Map<string, HTMLImageElement | 'err'>();
  constructor(private onLoad: () => void) {}
  get(path: string): HTMLImageElement | null {
    if (!path) return null;
    const hit = this.map.get(path);
    if (hit === 'err') return null;
    if (hit) return hit.complete && hit.naturalWidth ? hit : null;
    const img = new Image();
    img.onload = () => this.onLoad();
    img.onerror = () => this.map.set(path, 'err');
    img.src = imgUrl(path);
    this.map.set(path, img);
    return null;
  }
}

export class Renderer {
  private images = new ImageCache(() => this.onImage());
  /** вызывается, когда догрузилась картинка и нужен новый кадр */
  onImage: () => void = () => {};
  private ctx: CanvasRenderingContext2D;
  w = 0;
  h = 0;
  dpr = 1;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  draw(v: ViewState): void {
    const ctx = this.ctx;
    const { cam } = v;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = C.grass;
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.save();
    ctx.translate(this.w / 2, this.h / 2);
    ctx.scale(cam.s, cam.s);
    ctx.translate(-cam.x, -cam.y);

    if (v.grid) this.drawGrid(v);
    const geo = buildGeo(v.scene);
    this.drawSidewalks(geo);
    this.drawRoads(geo);
    this.drawRouteLanes(v, geo);
    if (v.mode === 'edit') this.drawIntersectionBoundaries(v, geo);
    this.drawTracks(geo);
    this.drawRailwayCrossings(v);
    this.drawRouteStops(v);
    this.drawStopPlaces(v);
    this.drawMarkings(v);
    this.drawCrosswalks(v, geo);
    this.drawLights(v, geo);
    this.drawObstacles(geo);
    this.drawSigns(v, geo);
    this.drawTrails(v);
    this.drawPaths(v);
    this.drawActors(v);
    this.drawCollisions(v);
    this.drawSelection(v, geo);
    this.drawDrawing(v);
    this.drawGhost(v);
    ctx.restore();

    this.drawLabels(v);
  }

  // ---- фон ---------------------------------------------------------------

  private drawGrid(v: ViewState): void {
    const { ctx } = this;
    const { cam } = v;
    const x0 = cam.x - this.w / 2 / cam.s;
    const x1 = cam.x + this.w / 2 / cam.s;
    const y0 = cam.y - this.h / 2 / cam.s;
    const y1 = cam.y + this.h / 2 / cam.s;
    const step = cam.s >= 14 ? 1 : cam.s >= 5 ? 5 : 10;
    ctx.strokeStyle = C.grassGrid;
    ctx.lineWidth = 1 / cam.s;
    ctx.beginPath();
    for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) {
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
    }
    for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) {
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
    }
    ctx.stroke();
  }

  private drawSidewalks(geo: Geo): void {
    const { ctx } = this;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    for (const sw of geo.sidewalks) {
      if (sw.pts.length < 2) continue;
      tracePath(ctx, sw.pts);
      ctx.strokeStyle = ['cyclepath', 'cycle-side', 'cycle-lane', 'cycle-zone'].includes(sw.item.mobilityKind ?? '') ? '#438b71' : C.sidewalk;
      ctx.lineWidth = sw.item.width;
      ctx.stroke();
      // бордюр
      tracePath(ctx, sw.pts);
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = sw.item.width + 0.3;
      ctx.globalCompositeOperation = 'destination-over';
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  private drawRoads(geo: Geo): void {
    const { ctx } = this;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    ctx.fillStyle = C.asphalt;
    for (const rg of geo.roads) {
      if (rg.pts.length < 2) continue;
      tracePath(ctx, roadOutlinePoly(rg), true);
      ctx.fill();
      // тонкая обводка скрывает щели между соседними многоугольниками
      ctx.strokeStyle = C.asphalt;
      ctx.lineWidth = 0.05;
      ctx.stroke();
    }
    // разметка: не рисуем внутри других дорог (перекрёстки)
    for (const rg of geo.roads) {
      if (rg.pts.length < 2) continue;
      ctx.save();
      for (const other of geo.roads) {
        if (other === rg || other.pts.length < 2) continue;
        ctx.beginPath();
        ctx.rect(-1e5, -1e5, 2e5, 2e5);
        const o = roadOutlinePoly(other);
        o.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.clip('evenodd');
      }
      this.drawRoadMarkings(rg);
      ctx.restore();
    }
  }

  private drawRouteLanes(v: ViewState, geo: Geo): void {
    const { ctx } = this;
    for (const road of geo.roads) {
      if (road.pts.length < 2) continue;
      for (const lane of road.road.routeLanes ?? []) {
        const effective = effectiveRouteLaneStations(v.scene.signs, road, lane);
        const from = Math.max(0, Math.min(road.total, effective.from));
        const to = Math.max(from, Math.min(road.total, effective.to));
        if (to <= from || !Number.isFinite(lane.width) || lane.width <= 0) continue;
        const stations = [from, ...road.samples.filter(sample => sample.s > from && sample.s < to).map(sample => sample.s), to];
        const frames = stations.map(station => frameAtStation(road.pts, road.cum, station));
        const edge = (offset: number) => frames.map(frame => add(frame.p, mul(rightOf(frame.a), offset)));
        const left = edge(lane.offset - lane.width / 2), right = edge(lane.offset + lane.width / 2);
        ctx.save();
        tracePath(ctx, [...left, ...right.reverse()], true);
        ctx.fillStyle = 'rgba(60,156,215,0.22)';
        ctx.fill();
        ctx.strokeStyle = '#80b9d7';
        ctx.lineWidth = Math.max(0.08, 1 / v.cam.s);
        ctx.setLineDash(lane.boundary === 'solid' ? [] : lane.boundary === 'dashed' ? [1.5, 1.5] : [0.3, 0.5]);
        ctx.stroke();
        ctx.setLineDash([]);
        const length = to - from;
        for (let station = from + Math.min(12, length / 2); station < to; station += 24) {
          const frame = frameAtStation(road.pts, road.cum, station);
          const at = add(frame.p, mul(rightOf(frame.a), lane.offset));
          const heading = frame.a + (lane.direction === 'reverse' ? Math.PI : 0);
          ctx.fillStyle = '#c5e4f5';
          this.arrow(at, heading, Math.min(1, lane.width * 0.3));
          if (length >= 8) {
            ctx.save();
            ctx.translate(at.x, at.y);
            ctx.rotate(heading);
            ctx.font = 'bold 0.9px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('МТС', -2.4, 0);
            ctx.restore();
          }
        }
        ctx.restore();
      }
    }
  }

  private drawStopPlaces(v: ViewState): void {
    const { ctx } = this;
    ctx.save();
    ctx.lineWidth = 1.5 / v.cam.s;
    for (const place of v.scene.stopPlaces ?? []) {
      if (!place.boundary.length) continue;
      ctx.strokeStyle = '#dcac5c'; ctx.fillStyle = '#dcac5c22';
      ctx.setLineDash([4 / v.cam.s, 3 / v.cam.s]);
      tracePath(ctx, place.boundary); ctx.closePath(); ctx.fill(); ctx.stroke();
      if (v.mode === 'edit') {
        ctx.setLineDash([]); ctx.fillStyle = '#f6dca7'; ctx.font = `${11 / v.cam.s}px system-ui`;
        ctx.fillText(place.id, place.boundary[0].x, place.boundary[0].y - 3 / v.cam.s);
      }
    }
    ctx.setLineDash([]);
    for (const actor of v.scene.actors) {
      const triangle = actor.warningContext?.triangle;
      if (!triangle || actor.warningContext?.trianglePlaced !== true) continue;
      const size = Math.max(0.4, 6 / v.cam.s);
      ctx.strokeStyle = '#f95545'; ctx.fillStyle = '#ffe8b0';
      tracePath(ctx, [{ x: triangle.x, y: triangle.y - size }, { x: triangle.x + size, y: triangle.y + size }, { x: triangle.x - size, y: triangle.y + size }]);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  private drawRouteStops(v: ViewState): void {
    const { ctx } = this;
    for (const stop of v.scene.routeStops ?? []) {
      ctx.save();
      ctx.translate(stop.x, stop.y);
      ctx.rotate(stop.heading);
      ctx.fillStyle = '#94d4f0';
      ctx.strokeStyle = '#284e67';
      ctx.lineWidth = 1 / v.cam.s;
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(0.25, 4 / v.cam.s), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      this.arrow({ x: 1.4, y: 0 }, 0, 0.6);
      ctx.restore();
    }
  }

  private drawRoadMarkings(rg: Geo['roads'][number]): void {
    const { ctx } = this;
    const r = rg.road;
    const S = rg.samples;
    ctx.strokeStyle = C.mark;
    ctx.lineJoin = 'round';
    /** линия, смещённая от оси на off(sample) метров вправо (отрицательное — влево) */
    const line = (off: (m: Geo['roads'][number]['samples'][number]) => number, dash: number[], w = 0.15) => {
      tracePath(ctx, S.map((m) => add(m.p, mul(m.n, off(m)))));
      ctx.lineWidth = w;
      ctx.setLineDash(dash);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    const inset = (w: number) => Math.max(0.2, w - 0.3);
    line((m) => inset(m.wr), []);
    line((m) => -inset(m.wl), []);
    if (r.oneWay) {
      for (let k = 1; k < r.lanes; k++) line((m) => -m.wl + ((m.wl + m.wr) * k) / r.lanes, [2, 4]);
      // стрелки направления: по одной на каждую полосу каждые 24 м
      ctx.fillStyle = 'rgba(242,244,248,0.55)';
      for (let s = 12; s < rg.total; s += 24) {
        const f = frameAtStation(rg.pts, rg.cum, s);
        const w = widthsAt(rg, s);
        for (let k = 0; k < r.lanes; k++) {
          const off = -w.l + ((w.l + w.r) * (k + 0.5)) / r.lanes;
          this.arrow(add(f.p, mul(rightOf(f.a), off)), f.a, 1.6);
        }
      }
      return;
    }
    for (let k = 1; k < r.lanes; k++) {
      line((m) => (m.wr * k) / r.lanes, [2, 4]);
      line((m) => -(m.wl * k) / r.lanes, [2, 4]);
    }
    switch (r.center) {
      case 'dashed':
        line(() => 0, [3, 6]);
        break;
      case 'solid':
        line(() => 0, []);
        break;
      case 'double':
        line(() => 0.17, []);
        line(() => -0.17, []);
        break;
      default:
        break;
    }
  }

  private arrow(p: Vec, a: number, size: number): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.5, size * 0.5);
    ctx.lineTo(-size * 0.2, 0);
    ctx.lineTo(-size * 0.5, -size * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawTracks(geo: Geo): void {
    const { ctx } = this;
    for (const tg of geo.tracks) {
      if (tg.pts.length < 2) continue;
      if (tg.item.separated || tg.item.kind === 'railway') {
        tracePath(ctx, tg.pts);
        ctx.strokeStyle = tg.item.kind === 'railway' ? '#817b70' : '#59606b';
        ctx.lineWidth = GAUGE + 1.4;
        ctx.stroke();
      }
      tracePath(ctx, tg.pts);
      ctx.strokeStyle = C.sleeper;
      ctx.lineWidth = GAUGE + 0.5;
      ctx.setLineDash([0.25, 0.6]);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const off of [-GAUGE / 2, GAUGE / 2]) {
        tracePath(ctx, offsetPolyline(tg.pts, off));
        ctx.strokeStyle = C.rail;
        ctx.lineWidth = 0.12;
        ctx.stroke();
      }
    }
  }

  private drawRailwayCrossings(v: ViewState): void {
    const { ctx } = this;
    for (const crossing of v.scene.railwayCrossings ?? []) {
      ctx.save();
      ctx.translate(crossing.x, crossing.y);
      ctx.rotate(crossing.angle);
      ctx.fillStyle = 'rgba(225,190,100,0.10)';
      ctx.fillRect(-crossing.length / 2, -crossing.width / 2, crossing.length, crossing.width);
      ctx.strokeStyle = '#e1be64';
      ctx.lineWidth = Math.max(0.06, 1 / v.cam.s);
      ctx.setLineDash([0.5, 0.5]);
      ctx.strokeRect(-crossing.length / 2, -crossing.width / 2, crossing.length, crossing.width);
      ctx.setLineDash([]);
      // Положение управления рисуется только по заданному расстоянию до крайних рельсов.
      if (crossing.controlDistance !== undefined) for (const side of [-1, 1]) {
        const x = side * (crossing.length / 2 + crossing.controlDistance);
        const y = side * crossing.width / 2;
        if (crossing.barrier && crossing.barrier !== 'none') {
          const closed = crossing.barrier === 'closed' || crossing.barrier === 'closing';
          ctx.save();
          ctx.translate(x, y);
          if (closed) ctx.rotate(-side * Math.PI / 2);
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 0.22;
          ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(crossing.width * 0.85, 0); ctx.stroke();
          ctx.strokeStyle = '#e5484d';
          ctx.setLineDash([0.55, 0.55]); ctx.stroke(); ctx.setLineDash([]);
          ctx.restore();
        }
        if (crossing.lightPresent === true) {
          ctx.fillStyle = '#171c24';
          ctx.fillRect(x - 0.4, y - 0.8, 0.8, 0.8);
          const lit = crossing.signal === 'red' || crossing.signal === 'white';
          const blink = Math.floor(v.t * 2) % 2 === 0;
          ctx.fillStyle = lit && blink ? crossing.signal === 'red' ? '#ff3844' : '#ecf0ff' : '#4e5663';
          ctx.beginPath(); ctx.arc(x, y - 0.4, 0.23, 0, Math.PI * 2); ctx.fill();
        }
      }
      if (crossing.stopLineDistance !== undefined) for (const side of [-1, 1]) {
        const x = side * (crossing.length / 2 + crossing.stopLineDistance);
        ctx.strokeStyle = '#f2f4f8'; ctx.lineWidth = 0.25;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, side * crossing.width / 2); ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawCrosswalks(v: ViewState, geo: Geo): void {
    const { ctx } = this;
    for (const cg of geo.crosswalks) {
      const c = cg.item;
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.angle);
      ctx.fillStyle = C.mark;
      const n = Math.floor(c.width / 1.0);
      for (let i = 0; i < n; i++) {
        const x = -c.width / 2 + 0.25 + i * 1.0;
        ctx.fillRect(x, -c.length / 2, 0.5, c.length);
      }
      const green = pedestrianGreen(v.scene, c, v.mode === 'play' ? v.t : 0);
      if (green !== null) {
        for (const sgn of [-1, 1]) {
          ctx.beginPath();
          ctx.arc(-c.width / 2 - 0.6, sgn * (c.length / 2 + 0.5), 0.4, 0, Math.PI * 2);
          ctx.fillStyle = green ? '#3ddc84' : '#ff4d4f';
          ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  private drawLights(v: ViewState, geo: Geo): void {
    const { ctx } = this;
    const t = v.mode === 'play' ? v.t : 0;
    for (const lg of geo.lights) {
      const l = lg.light;
      if (l.stopLine !== false) {
        ctx.beginPath();
        ctx.moveTo(lg.line.a.x, lg.line.a.y);
        ctx.lineTo(lg.line.b.x, lg.line.b.y);
        ctx.strokeStyle = C.mark;
        ctx.lineWidth = 0.4;
        ctx.stroke();
      }
      this.drawLightHead(l, t);
    }
  }

  private drawLightHead(l: TrafficLight, t: number): void {
    const { ctx } = this;
    const phase = lightPhase(l, t);
    const r = rightOf(l.angle);
    const p = add({ x: l.x, y: l.y }, mul(r, 0.9));
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(l.angle);
    const off = l.mode === 'off';
    if (l.kind === 'controller') {
      ctx.strokeStyle = off ? '#69737c' : '#f4f7fa';
      ctx.fillStyle = off ? '#69737c' : '#f4f7fa';
      ctx.lineWidth = 0.17;
      ctx.beginPath();
      ctx.arc(0.5, 0, 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-0.5, -0.23);
      ctx.lineTo(0.16, -0.23);
      ctx.lineTo(0.16, 0.23);
      ctx.lineTo(-0.5, 0.23);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      if (l.controllerGesture === 'right-arm-forward') {
        ctx.moveTo(0, -0.24); ctx.lineTo(0, -0.8);
        ctx.moveTo(0, 0.24); ctx.lineTo(0.8, 0.24);
      } else if (l.controllerGesture === 'arm-up' || l.controllerGesture === 'stop') {
        if (l.controllerGesture === 'stop') ctx.strokeStyle = '#ff6b6b';
        ctx.arc(0, 0, 0.83, 0, Math.PI * 2);
      } else {
        ctx.moveTo(0, -0.95); ctx.lineTo(0, 0.95);
      }
      ctx.stroke();
      ctx.restore();
      this.badge(l.controllerGesture === 'stop' ? 'Регулировщик: остановиться' : l.controllerGesture === 'arm-up' ? 'Регулировщик: рука вверх' : l.controllerGesture === 'right-arm-forward' ? 'Регулировщик: правая вперёд' : 'Регулировщик: руки в стороны / опущены', p.x, p.y + 1.6);
      return;
    }
    ctx.fillStyle = '#14171c';
    ctx.fillRect(-0.65, -0.65, 1.3, 1.3);
    if (l.kind === 'reversible') {
      const signal = l.reversibleState ?? 'green';
      ctx.strokeStyle = off ? '#55606a' : signal === 'red' ? '#ff4d4f' : signal === 'yellow' ? '#ffcf3d' : '#3ddc84';
      ctx.lineWidth = 0.16;
      ctx.beginPath();
      if (signal === 'red') {
        ctx.moveTo(-0.38, -0.38); ctx.lineTo(0.38, 0.38);
        ctx.moveTo(-0.38, 0.38); ctx.lineTo(0.38, -0.38);
      } else {
        if (signal === 'yellow') ctx.rotate(Math.PI / 4);
        ctx.moveTo(-0.4, 0); ctx.lineTo(0.4, 0);
        ctx.lineTo(0.05, -0.3); ctx.moveTo(0.4, 0); ctx.lineTo(0.05, 0.3);
      }
      ctx.stroke();
      ctx.restore();
      return;
    }
    if (l.kind === 'tram') {
      const allowed = off ? [] : l.tramDirections ?? [];
      const points = [{ x: -0.35, y: -0.35, on: allowed.includes('left') }, { x: 0, y: -0.35, on: allowed.includes('straight') }, { x: 0.35, y: -0.35, on: allowed.includes('right') }, { x: 0, y: 0.3, on: allowed.length > 0 }];
      for (const point of points) {
        ctx.beginPath(); ctx.arc(point.x, point.y, 0.13, 0, Math.PI * 2);
        ctx.fillStyle = point.on ? '#fff8dd' : '#4c4d43'; ctx.fill();
      }
      ctx.restore();
      return;
    }
    const flashing = l.mode === 'flashing-yellow';
    const col = off || (flashing && Math.floor(t * 2) % 2) ? '#55606a' : flashing || phase === 'yellow' ? '#ffcf3d' : phase === 'green' ? '#3ddc84' : '#ff4d4f';
    ctx.beginPath();
    ctx.arc(0, 0, 0.46, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.shadowColor = col;
    ctx.shadowBlur = 8;
    ctx.fill();
    if (l.kind === 'bicycle' || l.kind === 'pedestrian') {
      ctx.shadowBlur = 0; ctx.strokeStyle = '#14171c'; ctx.fillStyle = '#14171c'; ctx.lineWidth = 0.055;
      ctx.beginPath();
      if (l.kind === 'bicycle') {
        ctx.arc(-0.23, 0.12, 0.12, 0, Math.PI * 2); ctx.moveTo(0.35, 0.12); ctx.arc(0.23, 0.12, 0.12, 0, Math.PI * 2);
        ctx.moveTo(-0.23, 0.12); ctx.lineTo(-0.05, -0.12); ctx.lineTo(0.12, 0.12); ctx.closePath();
        ctx.moveTo(-0.05, -0.12); ctx.lineTo(0.15, -0.12); ctx.lineTo(0.23, 0.12); ctx.moveTo(0.15, -0.12); ctx.lineTo(0.1, -0.25);
      } else {
        ctx.arc(0, -0.23, 0.075, 0, Math.PI * 2); ctx.moveTo(0, -0.12); ctx.lineTo(0, 0.12);
        ctx.lineTo(-0.14, 0.3); ctx.moveTo(0, 0.12); ctx.lineTo(0.14, 0.3); ctx.moveTo(-0.16, 0.02); ctx.lineTo(0, -0.07); ctx.lineTo(0.16, 0.02);
      }
      ctx.stroke(); ctx.restore();
      this.badge(l.kind === 'bicycle' ? 'Сигнал велосипеда' : 'Сигнал пешехода', p.x, p.y + 1.3);
      return;
    }
    if (l.mainDirections?.length) this.drawSignalArrows(l.mainDirections, '#111820');
    if (l.extraSection) {
      ctx.translate(0, 1.05);
      ctx.fillStyle = '#14171c'; ctx.fillRect(-0.65, -0.45, 1.3, 0.9);
      this.drawSignalArrows(l.extraSection.directions, l.extraSection.on && !off && !flashing ? '#3ddc84' : '#55606a');
    }
    ctx.restore();
  }

  private drawSignalArrows(directions: string[], color: string): void {
    const { ctx } = this;
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.12;
    for (const direction of directions) {
      ctx.save();
      ctx.rotate(direction === 'right' ? Math.PI / 2 : direction === 'left' ? -Math.PI / 2 : direction === 'uturn' ? Math.PI : 0);
      ctx.beginPath(); ctx.moveTo(-0.27, 0); ctx.lineTo(0.32, 0);
      ctx.lineTo(0.08, -0.2); ctx.moveTo(0.32, 0); ctx.lineTo(0.08, 0.2); ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  private drawIntersectionBoundaries(v: ViewState, geo: Geo): void {
    const { ctx } = this;
    const selected = v.sel?.col === 'roads' ? v.sel.id : null;
    for (const intersection of geo.intersections) {
      if (selected && !intersection.roadIds.includes(selected)) continue;
      ctx.save();
      tracePath(ctx, intersection.boundary);
      ctx.closePath();
      ctx.setLineDash([0.6, 0.5]);
      ctx.strokeStyle = intersection.boundarySource === 'survey' ? 'rgba(84,221,200,0.7)' : 'rgba(255,209,102,0.4)';
      ctx.lineWidth = 1.5 / v.cam.s;
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawObstacles(geo: Geo): void {
    const { ctx } = this;
    for (const og of geo.obstacles) {
      const o = og.item;
      ctx.save();
      ctx.translate(o.x, o.y);
      ctx.rotate(o.angle);
      switch (o.kind) {
        case 'building':
          ctx.fillStyle = '#4a4f5c';
          ctx.fillRect(-o.w / 2, -o.h / 2, o.w, o.h);
          ctx.strokeStyle = '#6a7080';
          ctx.lineWidth = 0.3;
          ctx.strokeRect(-o.w / 2 + 0.6, -o.h / 2 + 0.6, o.w - 1.2, o.h - 1.2);
          break;
        case 'fence':
          ctx.fillStyle = '#7a5c3a';
          ctx.fillRect(-o.w / 2, -o.h / 2, o.w, o.h);
          break;
        case 'tree':
          ctx.beginPath();
          ctx.arc(0, 0, Math.max(o.w, o.h) / 2, 0, Math.PI * 2);
          ctx.fillStyle = '#2f7a46';
          ctx.fill();
          ctx.strokeStyle = '#1f5632';
          ctx.lineWidth = 0.2;
          ctx.stroke();
          break;
        case 'barrier': {
          ctx.fillStyle = '#e8e4d8';
          ctx.fillRect(-o.w / 2, -o.h / 2, o.w, o.h);
          ctx.fillStyle = '#e5484d';
          const n = Math.max(2, Math.round(o.w / 0.8));
          for (let i = 0; i < n; i += 2) ctx.fillRect(-o.w / 2 + (i * o.w) / n, -o.h / 2, o.w / n, o.h);
          break;
        }
      }
      ctx.restore();
    }
  }

  private drawSigns(v: ViewState, geo: Geo): void {
    const { ctx } = this;
    const showGate = v.mode === 'edit';
    for (const sg of geo.signs) {
      const s = sg.sign;
      if (showGate && v.sel?.col === 'signs' && v.sel.id === s.id) {
        ctx.beginPath();
        ctx.moveTo(sg.gate.a.x, sg.gate.a.y);
        ctx.lineTo(sg.gate.b.x, sg.gate.b.y);
        ctx.setLineDash([0.6, 0.6]);
        ctx.strokeStyle = 'rgba(255,209,102,0.7)';
        ctx.lineWidth = 0.12;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // линия остановки перед знаками «Уступите дорогу» и «Движение без остановки запрещено»
      if (s.kind === '2.4' || s.kind === '2.5' || s.kind === '3.17.3') {
        ctx.beginPath();
        ctx.moveTo(sg.gate.a.x, sg.gate.a.y);
        ctx.lineTo(sg.gate.b.x, sg.gate.b.y);
        ctx.strokeStyle = 'rgba(242,244,248,0.9)';
        ctx.lineWidth = s.kind === '2.4' ? 0.3 : 0.4;
        if (s.kind === '2.4') ctx.setLineDash([0.5, 0.5]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      this.drawSignIcon(s);
    }
  }

  /** Знаки с числом на самом знаке рисуем векторно, чтобы число совпадало с заданным. */
  private drawNumberSign(s: Sign): boolean {
    const { ctx } = this;
    const R = 0.75;
    const val = String(s.value ?? VALUE_SIGNS[s.kind]?.def ?? '');
    const circle = (fill: string, ring: string | null, text: string, textColor: string) => {
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      if (ring) {
        ctx.strokeStyle = ring;
        ctx.lineWidth = 0.17;
        ctx.stroke();
      }
      this.worldText(text, 0, 0, val.length > 2 ? 0.5 : 0.7, textColor);
    };
    ctx.save();
    ctx.translate(s.x, s.y);
    switch (s.kind) {
      case '3.24':
        circle('#fff', '#e5484d', val, '#111');
        break;
      case '3.25': {
        circle('#fff', '#222', val, '#222');
        ctx.strokeStyle = '#222';
        ctx.lineWidth = 0.1;
        ctx.beginPath();
        ctx.moveTo(-R * 0.7, R * 0.7);
        ctx.lineTo(R * 0.7, -R * 0.7);
        ctx.stroke();
        break;
      }
      case '4.6':
        circle('#1f6fd0', null, val, '#fff');
        break;
      case '5.31':
        ctx.fillStyle = '#fff';
        ctx.fillRect(-R, -R * 1.2, R * 2, R * 2.4);
        ctx.strokeStyle = '#222';
        ctx.lineWidth = 0.06;
        ctx.strokeRect(-R, -R * 1.2, R * 2, R * 2.4);
        this.worldText('ЗОНА', 0, -R * 0.8, 0.3, '#111');
        ctx.beginPath();
        ctx.arc(0, R * 0.25, R * 0.62, 0, Math.PI * 2);
        ctx.strokeStyle = '#e5484d';
        ctx.lineWidth = 0.13;
        ctx.stroke();
        this.worldText(val, 0, R * 0.25, 0.5, '#111');
        break;
      default:
        ctx.restore();
        return false;
    }
    ctx.restore();
    return true;
  }

  drawSignIcon(s: Sign): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.fillStyle = '#9aa3ad';
    ctx.fillRect(-0.06, -0.06, 0.12, 0.12);
    ctx.restore();
    if (s.kind === '8.13' && s.mainDirections?.length) this.drawMainRoadPlate(s.x, s.y, s.mainDirections);
    else if (!this.drawNumberSign(s)) {
      const img = this.images.get(signFile(s.kind));
      if (img) {
        // высота знака ~1.5 м, табличек — ~0.7 м
        const h = s.kind.startsWith('8.') ? 0.7 : 1.5;
        const w = (img.naturalWidth / img.naturalHeight) * h;
        const mw = Math.min(w, 2.4);
        ctx.drawImage(img, s.x - mw / 2, s.y - h / 2, mw, (mw / w) * h);
        const vs = VALUE_SIGNS[s.kind];
        if (vs && s.value !== undefined) this.badge(`${s.value} ${vs.unit}`, s.x, s.y + h / 2 + 0.35);
      } else {
        ctx.beginPath();
        ctx.arc(s.x, s.y, 0.7, 0, Math.PI * 2);
        ctx.fillStyle = '#3d4655';
        ctx.fill();
        this.worldText(s.kind, s.x, s.y, s.kind.length > 3 ? 0.34 : 0.45, '#fff');
      }
    }
    // таблички под знаком
    (s.plates ?? []).forEach((pl, k) => {
      const pimg = this.images.get(signFile(pl));
      const py = s.y + 1.2 + k * 0.62;
      if (pl === '8.13' && s.mainDirections?.length) this.drawMainRoadPlate(s.x, py, s.mainDirections);
      else if (pimg) {
        const ph = 0.55;
        const pw = Math.min(2, (pimg.naturalWidth / pimg.naturalHeight) * ph);
        ctx.drawImage(pimg, s.x - pw / 2, py - ph / 2, pw, ph);
      } else this.badge(pl, s.x, py);
    });
    // направление, которому адресован знак
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(s.angle);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 0.08;
    ctx.beginPath();
    ctx.moveTo(0.9, 0);
    ctx.lineTo(1.6, 0);
    ctx.lineTo(1.3, 0.25);
    ctx.moveTo(1.6, 0);
    ctx.lineTo(1.3, -0.25);
    ctx.stroke();
    ctx.restore();
  }

  /** 8.13 uses absolute inbound headings, so its drawn branches match the scene. */
  private drawMainRoadPlate(x: number, y: number, directions: number[]): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = '#fff'; ctx.fillRect(-0.5, -0.5, 1, 1);
    ctx.strokeStyle = '#171a20'; ctx.lineWidth = 0.04; ctx.strokeRect(-0.5, -0.5, 1, 1);
    ctx.lineWidth = 0.045;
    for (const heading of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0.4 * Math.cos(heading), 0.4 * Math.sin(heading)); ctx.stroke();
    }
    ctx.lineWidth = 0.15;
    for (const heading of directions) {
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-0.4 * Math.cos(heading), -0.4 * Math.sin(heading)); ctx.stroke();
    }
    ctx.restore();
  }

  /** Небольшая подпись в мировых координатах. */
  private badge(text: string, x: number, y: number): void {
    const { ctx } = this;
    ctx.save();
    ctx.font = '700 0.4px system-ui, sans-serif';
    const w = ctx.measureText(text).width + 0.3;
    ctx.fillStyle = 'rgba(12,15,20,0.85)';
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - 0.25, w, 0.5, 0.12);
    ctx.fill();
    ctx.fillStyle = '#f2f4f8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  // ---- разметка -------------------------------------------------------------

  private drawMarkings(v: ViewState): void {
    const { ctx } = this;
    for (const m of v.scene.markings) {
      const spec = MARKING_BY_ID[m.kind];
      if (!spec || !m.pts.length) continue;
      ctx.save();
      if (spec.form === 'line' && m.pts.length >= 2) this.markLine(m, spec);
      else if (spec.form === 'area' && m.pts.length >= 3) this.markArea(m, spec);
      else if (spec.form === 'symbol') this.markSymbol(m, spec);
      ctx.restore();
    }
  }

  private markLine(m: Scene['markings'][number], spec: MarkingSpec): void {
    const { ctx } = this;
    const pts = densify(m.pts, !!m.smooth, m.radius ?? 0);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = spec.color;
    ctx.fillStyle = spec.color;
    const stroke = (line: Vec[], dash?: [number, number], w = spec.width) => {
      tracePath(this.ctx, line);
      ctx.lineWidth = w;
      ctx.setLineDash(dash ?? []);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    if (spec.zigzag) {
      const out: Vec[] = [];
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        const dir = { x: (b.x - a.x) / (d || 1), y: (b.y - a.y) / (d || 1) };
        const n = rightOf(angleOf(dir));
        for (let t = 0; t < d; t += 0.6) {
          const k = Math.round((acc + t) / 0.6) % 2 ? 0.3 : -0.3;
          out.push({ x: a.x + dir.x * t + n.x * k, y: a.y + dir.y * t + n.y * k });
        }
        acc += d;
      }
      stroke(out, undefined, 0.12);
      return;
    }
    if (spec.triangles) {
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        const ang = angleOf({ x: b.x - a.x, y: b.y - a.y });
        for (let t = 0.25 - (acc % 0.9); t < d; t += 0.9) {
          if (t < 0) continue;
          const px = a.x + Math.cos(ang) * t;
          const py = a.y + Math.sin(ang) * t;
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(ang);
          ctx.beginPath();
          ctx.moveTo(0, -0.25);
          ctx.lineTo(0, 0.25);
          ctx.lineTo(-0.6, 0);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
        acc += d;
      }
      return;
    }
    const off = (d: number) => offsetPolyline(pts, d);
    switch (spec.pair) {
      case 'solid-solid':
        stroke(off(0.17));
        stroke(off(-0.17));
        break;
      case 'solid-dashed': {
        const solidSide = m.solidRight === false ? -0.17 : 0.17;
        stroke(off(solidSide));
        stroke(off(-solidSide), [1, 3]);
        break;
      }
      case 'dashed-dashed':
        stroke(off(0.2), spec.dash);
        stroke(off(-0.2), spec.dash);
        break;
      default:
        stroke(pts, spec.dash);
    }
  }

  private markArea(m: Scene['markings'][number], spec: MarkingSpec): void {
    const { ctx } = this;
    const pts = m.pts;
    tracePath(ctx, pts, true);
    ctx.fillStyle = 'rgba(242,244,248,0.12)';
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = spec.color;
    ctx.lineWidth = 0.2;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const y0 = Math.min(...ys);
    const y1 = Math.max(...ys);
    ctx.beginPath();
    for (let k = x0 - (y1 - y0); k < x1; k += 0.9) {
      ctx.moveTo(k, y1);
      ctx.lineTo(k + (y1 - y0), y0);
    }
    ctx.stroke();
    ctx.restore();
    tracePath(ctx, pts, true);
    ctx.strokeStyle = spec.color;
    ctx.lineWidth = spec.width + 0.05;
    ctx.stroke();
  }

  private markSymbol(m: Scene['markings'][number], spec: MarkingSpec): void {
    const { ctx } = this;
    const p = m.pts[0];
    ctx.translate(p.x, p.y);
    ctx.rotate(m.angle ?? 0);
    ctx.fillStyle = spec.color;
    ctx.strokeStyle = spec.color;
    if (spec.arrows) {
      const allow = ARROW_VARIANTS[m.variant ?? 'straight']?.allow ?? ['straight'];
      this.arrowShape(allow.includes('straight'), allow.includes('left') && !allow.includes('right') ? 'left' : allow.includes('right') && !allow.includes('left') ? 'right' : allow.includes('left') ? 'both' : null);
      return;
    }
    const img = this.images.get(markingFile(m.kind));
    if (img) {
      // картинки в PDF «вдоль дороги» смотрят вверх: поворачиваем на 90° к направлению движения
      ctx.rotate(Math.PI / 2);
      const h = 3.2;
      const w = (img.naturalWidth / img.naturalHeight) * h;
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
    } else {
      ctx.globalAlpha = 0.8;
      ctx.fillRect(-1.5, -0.4, 3, 0.8);
    }
  }

  /** Стрела 1.18: прямая и/или поворотная ветви. Направление движения — вдоль оси X. */
  private arrowShape(straight: boolean, turn: 'left' | 'right' | 'both' | null): void {
    const { ctx } = this;
    const L = 5;
    ctx.lineWidth = 0.35;
    ctx.lineCap = 'butt';
    const head = (x: number, y: number, ang: number) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(ang);
      ctx.beginPath();
      ctx.moveTo(0.9, 0);
      ctx.lineTo(-0.3, 0.75);
      ctx.lineTo(-0.3, -0.75);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };
    if (straight) {
      ctx.beginPath();
      ctx.moveTo(-L / 2, 0);
      ctx.lineTo(L / 2 - 0.4, 0);
      ctx.stroke();
      head(L / 2, 0, 0);
    }
    const branch = (sign: 1 | -1) => {
      ctx.beginPath();
      ctx.moveTo(-L / 2, 0);
      if (straight) {
        ctx.lineTo(-0.3, 0);
        ctx.quadraticCurveTo(0.8, 0, 1.4, sign * 1.2);
        ctx.lineTo(1.9, sign * 2.0);
        ctx.stroke();
        head(2.1, sign * 2.35, sign * 1.15);
      } else {
        ctx.lineTo(0.4, 0);
        ctx.quadraticCurveTo(1.6, 0, 1.6, sign * 1.4);
        ctx.lineTo(1.6, sign * 2.0);
        ctx.stroke();
        head(1.6, sign * 2.35, sign * Math.PI / 2);
      }
    };
    // y вниз: налево по ходу движения — это отрицательный Y
    if (turn === 'left' || turn === 'both') branch(-1);
    if (turn === 'right' || turn === 'both') branch(1);
  }

  /** Текст в мировых координатах (размер задаётся в метрах). */
  private worldText(text: string, x: number, y: number, size: number, color: string): void {
    const { ctx } = this;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = color;
    ctx.font = `700 ${size}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  // ---- участники ---------------------------------------------------------

  private poseOf(v: ViewState, a: Actor): { p: Vec; h: number; present: boolean; free: boolean } {
    if (v.mode === 'play' && v.tl) {
      const tr = v.tl.tracks.get(a.id);
      if (tr) {
        const k = Math.min(v.tl.n - 1, Math.max(0, Math.round(v.t / DT)));
        return { p: { x: tr.x[k], y: tr.y[k] }, h: tr.h[k], present: !!tr.present[k], free: !!tr.free[k] };
      }
    }
    const reversing = a.path.length && (a.path[0].v || a.speed) < 0;
    return { p: { x: a.x, y: a.y }, h: a.path.length ? angleOf(sub(a.path[0], a)) + (reversing ? Math.PI : 0) : a.heading, present: true, free: false };
  }

  private drawActors(v: ViewState): void {
    const { ctx } = this;
    for (const a of v.scene.actors) {
      const pose = this.poseOf(v, a);
      if (!pose.present) continue;
      const spec = actorSpec(a);
      ctx.save();
      ctx.translate(pose.p.x, pose.p.y);
      ctx.rotate(pose.h);
      const dim = v.focus && v.focus !== a.id;
      ctx.globalAlpha = dim ? 0.45 : 1;
      if (a.kind === 'pedestrian') {
        const r = spec.length / 2 + 0.1;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fillStyle = a.color;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 0.08;
        ctx.stroke();
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(r * 0.2, -0.07, r * 0.9, 0.14);
      } else {
        this.drawVehicleBody(a, spec.length, spec.width);
        if (!a.railwayTrain) {
          this.drawIndicators(a, spec.length, spec.width, v);
          this.drawSpecialSignals(a, spec.width, v);
        }
      }
      ctx.restore();
    }
  }

  private drawSpecialSignals(a: Actor, width: number, v: ViewState): void {
    const beacon = a.specialSignals?.beacon;
    if (!beacon || beacon === 'none' || beacon === 'unknown') return;
    const { ctx } = this;
    // Мигание — условное изображение включённого сигнала, не измеренная частота устройства.
    const phase = Math.floor(v.t * 4) % 2;
    const radius = Math.max(0.12, Math.min(width * 0.16, 4 / v.cam.s));
    ctx.save();
    ctx.fillStyle = '#151c28';
    ctx.fillRect(-radius * 1.4, -width * 0.3 - radius, radius * 2.8, width * 0.6 + radius * 2);
    const color = { blue: '#318dff', 'blue-red': '#318dff', yellow: '#ffbd24', orange: '#ff8c20', white: '#f5f7ff' }[beacon];
    for (const side of [-1, 1]) {
      const lit = beacon === 'blue-red' ? (side < 0 ? phase === 0 : phase === 1) : phase === 0;
      const lampColor = beacon === 'blue-red' && side > 0 ? '#ff3844' : color;
      ctx.fillStyle = lit ? lampColor : '#35404e';
      ctx.shadowColor = lit ? lampColor : 'transparent';
      ctx.shadowBlur = lit ? 8 : 0;
      ctx.beginPath();
      ctx.arc(0, side * width * 0.3, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawIndicators(a: Actor, length: number, width: number, v: ViewState): void {
    if (a.maneuverContext?.indicatorsUnavailable || Math.floor(v.t * 2) % 2 !== 0) return;
    const track = v.mode === 'play' ? v.tl?.tracks.get(a.id) : undefined;
    const state = vehicleSignalAt(a, v.t, track?.waypointTimes);
    if (state.signal === 'none') return;
    const { ctx } = this;
    const radius = Math.max(0.11, Math.min(width * 0.3, 2.4 / v.cam.s));
    ctx.save();
    ctx.fillStyle = '#ffb020';
    ctx.strokeStyle = '#6b3d00';
    ctx.lineWidth = Math.max(0.045, 0.7 / v.cam.s);
    ctx.shadowColor = '#ffb020';
    ctx.shadowBlur = 5;
    const sides = state.signal === 'hazard' ? [-1, 1] : state.signal === 'left' ? [-1] : [1];
    for (const side of sides) for (const x of [-length / 2 + 0.16, length / 2 - 0.16]) {
      ctx.beginPath();
      ctx.arc(x, side * width / 2, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawVehicleBody(a: Actor, L: number, W: number): void {
    const { ctx } = this;
    if (a.type === 'sim' && (!L || !W)) {
      ctx.fillStyle = a.color; ctx.beginPath(); ctx.arc(0, 0, 0.5, 0, Math.PI * 2); ctx.fill(); return;
    }
    const type = a.type as VehicleType;
    const rr = Math.min(0.5, W / 3);
    const rect = (x: number, y: number, w: number, h: number, r: number) => {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
    };
    rect(-L / 2, -W / 2, L, W, rr);
    ctx.fillStyle = a.color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.lineWidth = 0.1;
    ctx.stroke();
    ctx.fillStyle = 'rgba(15,25,45,0.75)';
    switch (type) {
      case 'sim':
      case 'bicycle':
      case 'moped':
      case 'motorcycle':
        ctx.beginPath();
        ctx.arc(-L * 0.05, 0, W * 0.42, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(20,24,30,0.85)';
        ctx.fill();
        break;
      case 'tram':
        for (let i = 1; i < (a.railwayTrain ? Math.min(100, Math.ceil(L / 15)) : 3); i++) {
          const sections = a.railwayTrain ? Math.min(100, Math.ceil(L / 15)) : 3;
          ctx.fillRect(-L / 2 + (i * L) / sections - 0.08, -W / 2, 0.16, W);
        }
        ctx.fillRect(L / 2 - 1.6, -W / 2 + 0.2, 1.3, W - 0.4);
        break;
      case 'bus':
      case 'trolleybus':
        ctx.fillRect(L / 2 - 1.5, -W / 2 + 0.2, 1.2, W - 0.4);
        for (let i = 0; i < 5; i++) ctx.fillRect(-L / 2 + 0.8 + i * 2, -W / 2 + 0.12, 1.5, 0.3);
        if (type === 'trolleybus') {
          ctx.strokeStyle = '#222';
          ctx.lineWidth = 0.1;
          ctx.beginPath();
          ctx.moveTo(-L / 2 + 0.5, -0.4);
          ctx.lineTo(-L / 2 - 1.0, -0.8);
          ctx.moveTo(-L / 2 + 0.5, 0.4);
          ctx.lineTo(-L / 2 - 1.0, 0.8);
          ctx.stroke();
        }
        break;
      case 'truck':
        ctx.fillRect(L / 2 - 1.7, -W / 2 + 0.2, 1.4, W - 0.4);
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(-L / 2 + 0.1, -W / 2 + 0.1, L - 2.2, W - 0.2);
        break;
      case 'cart':
        ctx.beginPath();
        ctx.ellipse(L / 2 + 0.9, 0, 1.0, 0.45, 0, 0, Math.PI * 2);
        ctx.fillStyle = '#6d4c2f';
        ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(-L / 2 + 0.2, -W / 2 + 0.2, L - 0.4, W - 0.4);
        break;
      default:
        // легковые, внедорожник, микроавтобус: лобовое и заднее стекло
        ctx.fillRect(L * 0.1, -W / 2 + 0.2, L * 0.2, W - 0.4);
        ctx.fillRect(-L * 0.38, -W / 2 + 0.2, L * 0.1, W - 0.4);
        break;
    }
    // груз и его свесы
    const c = a.cargo;
    if (c) {
      const x0 = -L / 2 + 0.2 - c.rear;
      const x1 = L / 2 - 0.2 + c.front;
      const y0 = -W / 2 + 0.1 - c.left;
      const y1 = W / 2 - 0.1 + c.right;
      ctx.fillStyle = 'rgba(160,118,70,0.85)';
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = 'rgba(60,40,20,0.9)';
      ctx.lineWidth = 0.08;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      if (c.marked) {
        // опознавательные знаки «Крупногабаритный груз»: красно-белые полосы на свисающих концах
        ctx.fillStyle = '#e5484d';
        for (const [xa, xb] of [[x1 - 0.4, x1], [x0, x0 + 0.4]]) ctx.fillRect(xa, y0, xb - xa, y1 - y0);
        ctx.fillStyle = '#fff';
        ctx.fillRect(x1 - 0.25, y0, 0.12, y1 - y0);
        ctx.fillRect(x0 + 0.13, y0, 0.12, y1 - y0);
      }
    }
    // передок
    ctx.fillStyle = '#fff3b0';
    ctx.fillRect(L / 2 - 0.12, -W / 2 + 0.12, 0.12, 0.28);
    ctx.fillRect(L / 2 - 0.12, W / 2 - 0.4, 0.12, 0.28);
  }

  private drawTrails(v: ViewState): void {
    if (v.mode !== 'play' || !v.tl) return;
    const { ctx } = this;
    const kNow = Math.min(v.tl.n - 1, Math.round(v.t / DT));
    for (const a of v.scene.actors) {
      const tr = v.tl.tracks.get(a.id);
      if (!tr) continue;
      ctx.beginPath();
      let started = false;
      for (let k = 0; k <= kNow; k += 2) {
        if (!tr.present[k]) continue;
        if (!started) {
          ctx.moveTo(tr.x[k], tr.y[k]);
          started = true;
        } else ctx.lineTo(tr.x[k], tr.y[k]);
      }
      ctx.strokeStyle = a.color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = Math.min(0.5, actorSpec(a).width * 0.25);
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineCap = 'butt';
    }
  }

  private drawPaths(v: ViewState): void {
    if (v.mode === 'play') return;
    const { ctx } = this;
    for (const a of v.scene.actors) {
      if (!a.path.length) continue;
      const active = v.pathActor === a.id || (v.sel?.col === 'actors' && v.sel.id === a.id);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      for (const w of a.path) ctx.lineTo(w.x, w.y);
      ctx.strokeStyle = a.color;
      ctx.globalAlpha = active ? 0.95 : 0.45;
      ctx.lineWidth = active ? 0.22 : 0.14;
      ctx.setLineDash([0.8, 0.5]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      // стрелка к первой точке и точки
      a.path.forEach((w, i) => {
        const prev = i === 0 ? { x: a.x, y: a.y } : a.path[i - 1];
        ctx.fillStyle = a.color;
        ctx.globalAlpha = active ? 1 : 0.6;
        ctx.beginPath();
        ctx.arc(w.x, w.y, active ? 0.45 : 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = v.selWp === i && active ? C.sel : 'rgba(0,0,0,0.7)';
        ctx.lineWidth = v.selWp === i && active ? 0.18 : 0.08;
        ctx.stroke();
        ctx.globalAlpha = 1;
        const ang = angleOf(sub(w, prev));
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        this.arrow(add(prev, mul(fromAngle(ang), Math.hypot(w.x - prev.x, w.y - prev.y) / 2)), ang, 0.6);
      });
    }
  }

  private drawCollisions(v: ViewState): void {
    if (v.mode !== 'play' || !v.tl) return;
    const { ctx } = this;
    for (const c of v.tl.collisions) {
      if (v.t < c.t) continue;
      const age = v.t - c.t;
      ctx.save();
      ctx.translate(c.point.x, c.point.y);
      if (age < 0.9) {
        const k = age / 0.9;
        const R = 1.0 + 2.2 * k;
        ctx.globalAlpha = 1 - k;
        ctx.beginPath();
        for (let i = 0; i < 16; i++) {
          const r = i % 2 ? R * 0.5 : R;
          const a = (i * Math.PI) / 8;
          i ? ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r) : ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        ctx.closePath();
        ctx.fillStyle = '#ffb224';
        ctx.fill();
        ctx.strokeStyle = '#e5484d';
        ctx.lineWidth = 0.18;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      // постоянная отметка места удара
      ctx.strokeStyle = '#ff4d4f';
      ctx.lineWidth = 0.22;
      ctx.beginPath();
      ctx.moveTo(-0.6, -0.6);
      ctx.lineTo(0.6, 0.6);
      ctx.moveTo(0.6, -0.6);
      ctx.lineTo(-0.6, 0.6);
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---- интерфейс редактора ----------------------------------------------

  private drawSelection(v: ViewState, geo: Geo): void {
    if (!v.sel || v.mode === 'play') return;
    const { ctx } = this;
    const { cam } = v;
    const px = 1 / cam.s;
    ctx.strokeStyle = C.sel;
    ctx.fillStyle = C.sel;
    ctx.lineWidth = 2 * px;
    const handle = (p: Vec, r = 6) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * px, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.strokeStyle = C.sel;
      ctx.stroke();
    };
    const s = v.scene;
    switch (v.sel.col) {
      case 'roads':
      case 'sidewalks':
      case 'markings':
      case 'tracks': {
        const it = (s[v.sel.col] as { id: string; pts: Vec[] }[]).find((x) => x.id === v.sel!.id);
        if (!it) return;
        tracePath(ctx, it.pts);
        ctx.setLineDash([6 * px, 4 * px]);
        ctx.stroke();
        ctx.setLineDash([]);
        it.pts.forEach((p) => handle(p));
        if (v.sel.col === 'markings') {
          const m = it as unknown as { kind: string; pts: Vec[]; angle?: number };
          if (MARKING_BY_ID[m.kind]?.form === 'symbol') handle(add(m.pts[0], mul(fromAngle(m.angle ?? 0), 3.2)));
        }
        if (v.sel.col === 'roads') {
          const rg = geo.roads.find((x) => x.road.id === v.sel!.id);
          if (rg && rg.pts.length >= 2) {
            // кромки и их точки профиля: левая — оранжевая, правая — бирюзовая
            for (const side of ['l', 'r'] as const) {
              const col = side === 'l' ? '#ff9f43' : '#3ddbd9';
              tracePath(ctx, side === 'l' ? rg.left : rg.right);
              ctx.strokeStyle = col;
              ctx.lineWidth = 2 * px;
              ctx.stroke();
              for (const e of (side === 'l' ? rg.road.wl : rg.road.wr) ?? []) {
                const f = frameAtStation(rg.pts, rg.cum, e.s);
                const n = rightOf(f.a);
                const p = add(f.p, mul(n, side === 'l' ? -e.w : e.w));
                ctx.beginPath();
                ctx.arc(p.x, p.y, 6 * px, 0, Math.PI * 2);
                ctx.fillStyle = col;
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 1.5 * px;
                ctx.stroke();
              }
            }
            ctx.strokeStyle = C.sel;
          }
        }
        break;
      }
      case 'actors': {
        const a = s.actors.find((x) => x.id === v.sel!.id);
        if (!a) return;
        const pose = this.poseOf(v, a);
        const sp = actorSpec(a);
        ctx.save();
        ctx.translate(pose.p.x, pose.p.y);
        ctx.rotate(pose.h);
        ctx.strokeStyle = C.sel;
        ctx.setLineDash([5 * px, 4 * px]);
        ctx.strokeRect(-sp.length / 2 - 0.3, -sp.width / 2 - 0.3, sp.length + 0.6, sp.width + 0.6);
        ctx.setLineDash([]);
        ctx.restore();
        if (!a.path.length || v.pathActor !== a.id) handle(rotateHandle(a), 6);
        break;
      }
      case 'crosswalks':
      case 'lights':
      case 'signs':
      case 'obstacles': {
        const it = (s[v.sel.col] as { id: string; x: number; y: number; angle: number }[]).find((x) => x.id === v.sel!.id);
        if (!it) return;
        ctx.beginPath();
        ctx.arc(it.x, it.y, 1.4, 0, Math.PI * 2);
        ctx.setLineDash([5 * px, 4 * px]);
        ctx.stroke();
        ctx.setLineDash([]);
        handle(rotateHandle(it));
        break;
      }
    }
      }

  private drawDrawing(v: ViewState): void {
    const d = v.drawing;
    if (!d || !d.pts.length) return;
    const { ctx } = this;
    const px = 1 / v.cam.s;
    const raw = d.cursor ? [...d.pts, d.cursor] : d.pts;
    const pts = POLY.includes(d.tool) ? densify(raw, !!v.brush?.smooth, v.brush?.radius ?? 0) : raw;
    tracePath(ctx, pts);
    ctx.strokeStyle = d.tool === 'path' ? '#ffd166' : d.tool === 'road' ? 'rgba(255,255,255,0.55)' : 'rgba(255,209,102,0.8)';
    ctx.lineWidth = d.tool === 'road' ? 3.5 : d.tool === 'sidewalk' ? 2 : 0.2;
    ctx.globalAlpha = d.tool === 'road' || d.tool === 'sidewalk' ? 0.4 : 1;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.globalAlpha = 1;
    for (const p of d.pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5 * px, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
    }
  }

  private drawGhost(v: ViewState): void {
    const g = v.ghost;
    if (!g) return;
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.translate(g.at.x, g.at.y);
    ctx.rotate(g.angle);
    if (g.tool === 'vehicle') {
      const sp = VEHICLES[g.kind as VehicleType];
      ctx.fillStyle = sp.color;
      ctx.fillRect(-sp.length / 2, -sp.width / 2, sp.length, sp.width);
    } else if (g.tool === 'ped') {
      const sp = PEDESTRIANS[g.kind as PedestrianType];
      ctx.beginPath();
      ctx.arc(0, 0, sp.size / 2 + 0.1, 0, Math.PI * 2);
      ctx.fillStyle = sp.color;
      ctx.fill();
    } else {
      ctx.strokeStyle = C.sel;
      ctx.lineWidth = 0.15;
      ctx.beginPath();
      ctx.arc(0, 0, 0.8, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = C.sel;
    ctx.lineWidth = 0.15;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(3, 0);
    ctx.stroke();
    ctx.restore();
  }

  // ---- подписи (в экранных координатах) -----------------------------------

  private drawLabels(v: ViewState): void {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const [index, stop] of (v.scene.routeStops ?? []).entries()) {
      const point = worldToScreen(v.cam, this.w, this.h, stop);
      const text = `Остановочное место ${index + 1}`;
      const width = ctx.measureText(text).width + 10;
      ctx.fillStyle = 'rgba(12,15,20,0.85)';
      ctx.fillRect(point.x - width / 2, point.y - 26, width, 18);
      ctx.fillStyle = '#a5d8ef';
      ctx.fillText(text, point.x, point.y - 11);
    }
    for (const [index, crossing] of (v.scene.railwayCrossings ?? []).entries()) {
      const point = worldToScreen(v.cam, this.w, this.h, crossing);
      const barrier = { none: 'без шлагбаума', open: 'шлагбаум открыт', closing: 'шлагбаум закрывается', closed: 'шлагбаум закрыт' };
      const signal = { off: 'сигналы выключены', red: 'красный', white: 'бело-лунный' };
      const text = `Переезд ${index + 1}: ${crossing.barrier ? barrier[crossing.barrier] : 'шлагбаум ?'}, ${crossing.signal ? signal[crossing.signal] : 'сигнал ?'}`;
      const width = ctx.measureText(text).width + 10;
      ctx.fillStyle = 'rgba(12,15,20,0.85)';
      ctx.fillRect(point.x - width / 2, point.y - 24, width, 18);
      ctx.fillStyle = '#e1be64';
      ctx.fillText(text, point.x, point.y - 9);
    }
    const labels = actorLabels(v.scene);
    for (const a of v.scene.actors) {
      const pose = this.poseOf(v, a);
      if (!pose.present) continue;
      const sp = actorSpec(a);
      const s = worldToScreen(v.cam, this.w, this.h, pose.p);
      const y = s.y - (sp.width / 2) * v.cam.s - 10;
      const text = `${labels.get(a.id) ?? ''}${a.railwayTrain ? ' · поезд' : ''}${a.specialSignals?.siren === true ? ' · сирена' : ''}`;
      const w = ctx.measureText(text).width + 8;
      ctx.fillStyle = 'rgba(12,15,20,0.78)';
      ctx.beginPath();
      ctx.roundRect(s.x - w / 2, y - 14, w, 16, 4);
      ctx.fill();
      ctx.fillStyle = a.color;
      ctx.fillRect(s.x - w / 2 + 3, y - 10, 3, 8);
      ctx.fillStyle = '#f2f4f8';
      ctx.fillText(text, s.x + 2, y);
    }
    // скорости путевых точек в режиме редактирования
    if (v.mode === 'edit') {
      ctx.textBaseline = 'middle';
      for (const a of v.scene.actors) {
        const active = v.pathActor === a.id || (v.sel?.col === 'actors' && v.sel.id === a.id);
        if (!active) continue;
        a.path.forEach((w) => {
          const s = worldToScreen(v.cam, this.w, this.h, w);
          const txt = `${Math.round(w.v)}`;
          const tw = ctx.measureText(txt).width + 6;
          ctx.fillStyle = 'rgba(12,15,20,0.85)';
          ctx.beginPath();
          ctx.roundRect(s.x + 8, s.y - 8, tw, 16, 4);
          ctx.fill();
          ctx.fillStyle = '#f2f4f8';
          ctx.textAlign = 'left';
          ctx.fillText(txt, s.x + 11, s.y);
        });
        ctx.textAlign = 'center';
      }
    }
    // скорость в режиме воспроизведения
    if (v.mode === 'play' && v.tl) {
      const k = Math.min(v.tl.n - 1, Math.round(v.t / DT));
      ctx.textBaseline = 'top';
      for (const a of v.scene.actors) {
        const tr = v.tl.tracks.get(a.id);
        if (!tr || !tr.present[k]) continue;
        const s = worldToScreen(v.cam, this.w, this.h, { x: tr.x[k], y: tr.y[k] });
        const txt = `${tr.reversing?.[k] ? 'Задний ход · ' : ''}${Math.round(kmh(tr.v[k]))} км/ч`;
        const tw = ctx.measureText(txt).width + 8;
        const y = s.y + (actorSpec(a).width / 2) * v.cam.s + 10;
        ctx.fillStyle = 'rgba(12,15,20,0.78)';
        ctx.beginPath();
        ctx.roundRect(s.x - tw / 2, y, tw, 16, 4);
        ctx.fill();
        ctx.fillStyle = '#f2f4f8';
        ctx.fillText(txt, s.x, y + 2);
      }
    }
  }
}

/** Положение ручки поворота относительно объекта. */
export function rotateHandle(it: { x: number; y: number; angle?: number; heading?: number; path?: unknown[] }): Vec {
  const a = it.angle ?? it.heading ?? 0;
  return add({ x: it.x, y: it.y }, mul(fromAngle(a), 3.2));
}
