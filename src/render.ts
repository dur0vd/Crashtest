import { type Geo, buildGeo } from './geo';
import { type Vec, add, angleOf, fromAngle, kmh, mul, norm, rightOf, sub } from './geom';
import type { Report } from './analysis';
import {
  type Actor,
  type Scene,
  type Sign,
  type TrafficLight,
  LANE_WIDTH,
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

export interface Camera {
  x: number;
  y: number;
  /** пикселей на метр */
  s: number;
}

export interface Selection {
  col: 'roads' | 'sidewalks' | 'tracks' | 'crosswalks' | 'lights' | 'signs' | 'obstacles' | 'actors';
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

export interface ViewState {
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

function roadOutline(pts: Vec[], half: number): Vec[] {
  return [...offsetPolyline(pts, half), ...offsetPolyline(pts, -half).reverse()];
}

export class Renderer {
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
    this.drawTracks(geo);
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
      ctx.strokeStyle = C.sidewalk;
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
    for (const rg of geo.roads) {
      if (rg.pts.length < 2) continue;
      tracePath(ctx, rg.pts);
      ctx.strokeStyle = C.asphalt;
      ctx.lineWidth = rg.width;
      ctx.stroke();
    }
    // разметка: не рисуем внутри других дорог (перекрёстки)
    for (const rg of geo.roads) {
      if (rg.pts.length < 2) continue;
      ctx.save();
      const big = { x0: -1e5, y0: -1e5, x1: 1e5, y1: 1e5 };
      for (const other of geo.roads) {
        if (other === rg || other.pts.length < 2) continue;
        ctx.beginPath();
        ctx.rect(big.x0, big.y0, big.x1 - big.x0, big.y1 - big.y0);
        const o = roadOutline(other.pts, other.half);
        o.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.clip('evenodd');
      }
      this.drawRoadMarkings(rg);
      ctx.restore();
    }
  }

  private drawRoadMarkings(rg: Geo['roads'][number]): void {
    const { ctx } = this;
    const r = rg.road;
    const half = rg.half;
    ctx.strokeStyle = C.mark;
    ctx.lineJoin = 'round';
    const line = (off: number, dash: number[], w = 0.15) => {
      tracePath(ctx, offsetPolyline(rg.pts, off));
      ctx.lineWidth = w;
      ctx.setLineDash(dash);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    line(half - 0.3, []);
    line(-(half - 0.3), []);
    if (r.oneWay) {
      for (let k = 1; k < r.lanes; k++) line(-half + k * LANE_WIDTH, [2, 4]);
      // стрелки направления
      ctx.fillStyle = 'rgba(242,244,248,0.55)';
      let acc = 0;
      for (let i = 1; i < rg.pts.length; i++) {
        const a = rg.pts[i - 1];
        const b = rg.pts[i];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        const dir = norm(sub(b, a));
        for (let s = 12 - (acc % 24); s < d; s += 24) {
          const p = add(a, mul(dir, s));
          for (let k = 0; k < r.lanes; k++) {
            const lp = add(p, mul(rightOf(angleOf(dir)), -half + LANE_WIDTH * (k + 0.5)));
            this.arrow(lp, angleOf(dir), 1.6);
          }
        }
        acc += d;
      }
      return;
    }
    for (let k = 1; k < r.lanes; k++) {
      line(k * LANE_WIDTH, [2, 4]);
      line(-k * LANE_WIDTH, [2, 4]);
    }
    switch (r.center) {
      case 'dashed':
        line(0, [3, 6]);
        break;
      case 'solid':
        line(0, []);
        break;
      case 'double':
        line(0.17, []);
        line(-0.17, []);
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
      if (tg.item.separated) {
        tracePath(ctx, tg.pts);
        ctx.strokeStyle = '#59606b';
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
      ctx.beginPath();
      ctx.moveTo(lg.line.a.x, lg.line.a.y);
      ctx.lineTo(lg.line.b.x, lg.line.b.y);
      ctx.strokeStyle = C.mark;
      ctx.lineWidth = 0.4;
      ctx.stroke();
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
    ctx.fillStyle = '#14171c';
    ctx.fillRect(-0.45, -0.55, 0.9, 1.1);
    const col = phase === 'green' ? '#3ddc84' : phase === 'yellow' ? '#ffcf3d' : '#ff4d4f';
    ctx.beginPath();
    ctx.arc(0, 0, 0.36, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.shadowColor = col;
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.restore();
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
      if (s.kind === 'stop' || s.kind === 'giveway') {
        ctx.beginPath();
        ctx.moveTo(sg.gate.a.x, sg.gate.a.y);
        ctx.lineTo(sg.gate.b.x, sg.gate.b.y);
        ctx.strokeStyle = 'rgba(242,244,248,0.9)';
        ctx.lineWidth = s.kind === 'stop' ? 0.4 : 0.3;
        if (s.kind === 'giveway') ctx.setLineDash([0.5, 0.5]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      this.drawSignIcon(s);
    }
  }

  drawSignIcon(s: Sign): void {
    const { ctx } = this;
    const R = 0.7;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.fillStyle = '#9aa3ad';
    ctx.fillRect(-0.06, -0.06, 0.12, 0.12);
    ctx.lineWidth = 0.12;
    const poly = (n: number, rot: number, r: number) => {
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const a = rot + (i * 2 * Math.PI) / n;
        i ? ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r) : ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
    };
    switch (s.kind) {
      case 'main':
        poly(4, Math.PI / 4, R * 1.1);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        poly(4, Math.PI / 4, R * 0.8);
        ctx.fillStyle = '#ffcf3d';
        ctx.fill();
        break;
      case 'giveway':
        poly(3, Math.PI / 2, R * 1.2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#e5484d';
        ctx.lineWidth = 0.18;
        ctx.stroke();
        break;
      case 'stop':
        poly(8, Math.PI / 8, R);
        ctx.fillStyle = '#e5484d';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 0.08;
        ctx.stroke();
        break;
      case 'noentry':
        ctx.beginPath();
        ctx.arc(0, 0, R, 0, Math.PI * 2);
        ctx.fillStyle = '#e5484d';
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillRect(-R * 0.65, -0.13, R * 1.3, 0.26);
        break;
      case 'limit':
      case 'noovertake':
        ctx.beginPath();
        ctx.arc(0, 0, R, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.strokeStyle = '#e5484d';
        ctx.lineWidth = 0.16;
        ctx.stroke();
        break;
      case 'crosswalk':
        ctx.fillStyle = '#2f6fe0';
        ctx.fillRect(-R, -R, R * 2, R * 2);
        poly(3, -Math.PI / 2, R * 0.65);
        ctx.fillStyle = '#fff';
        ctx.fill();
        break;
    }
    ctx.restore();
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
    if (s.kind === 'limit' || s.kind === 'noovertake') {
      this.worldText(s.kind === 'limit' ? String(s.value ?? 40) : 'ОБГ', s.x, s.y, 0.62, '#111');
    } else if (s.kind === 'stop') {
      this.worldText('STOP', s.x, s.y, 0.32, '#fff');
    }
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
    return { p: { x: a.x, y: a.y }, h: a.path.length ? angleOf(sub(a.path[0], a)) : a.heading, present: true, free: false };
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
      }
      ctx.restore();
    }
  }

  private drawVehicleBody(a: Actor, L: number, W: number): void {
    const { ctx } = this;
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
      case 'bicycle':
      case 'moped':
      case 'motorcycle':
        ctx.beginPath();
        ctx.arc(-L * 0.05, 0, W * 0.42, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(20,24,30,0.85)';
        ctx.fill();
        break;
      case 'tram':
        for (let i = 1; i < 3; i++) {
          ctx.fillRect(-L / 2 + (i * L) / 3 - 0.08, -W / 2, 0.16, W);
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
      case 'tracks': {
        const it = (s[v.sel.col] as { id: string; pts: Vec[] }[]).find((x) => x.id === v.sel!.id);
        if (!it) return;
        tracePath(ctx, it.pts);
        ctx.setLineDash([6 * px, 4 * px]);
        ctx.stroke();
        ctx.setLineDash([]);
        it.pts.forEach((p) => handle(p));
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
    void geo;
  }

  private drawDrawing(v: ViewState): void {
    const d = v.drawing;
    if (!d || !d.pts.length) return;
    const { ctx } = this;
    const px = 1 / v.cam.s;
    const pts = d.cursor ? [...d.pts, d.cursor] : d.pts;
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
    const labels = actorLabels(v.scene);
    for (const a of v.scene.actors) {
      const pose = this.poseOf(v, a);
      if (!pose.present) continue;
      const sp = actorSpec(a);
      const s = worldToScreen(v.cam, this.w, this.h, pose.p);
      const y = s.y - (sp.width / 2) * v.cam.s - 10;
      const text = labels.get(a.id) ?? '';
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
        const txt = `${Math.round(kmh(tr.v[k]))} км/ч`;
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
