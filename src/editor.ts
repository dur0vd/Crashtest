import { buildGeo, roadsAt } from './geo';
import {
  type Vec,
  add,
  angleOf,
  clamp,
  dist,
  distToSegment,
  mul,
  nearestOnPolyline,
  pointInObb,
  rad,
  rightOf,
  sub,
  wrapAngle,
} from './geom';
import { type Camera, type DrawingState, type GhostState, type Selection, Renderer, rotateHandle, screenToWorld } from './render';
import {
  type Actor,
  type CenterMarking,
  type Collection,
  type ObstacleKind,
  type PedestrianType,
  type RoadZone,
  type Scene,
  type SignKind,
  type VehicleType,
  LANE_WIDTH,
  PEDESTRIANS,
  VEHICLES,
  actorSpec,
  cloneScene,
  newId,
} from './scene';

export type Tool =
  | 'select'
  | 'pan'
  | 'road'
  | 'sidewalk'
  | 'track'
  | 'crosswalk'
  | 'light'
  | 'sign'
  | 'obstacle'
  | 'vehicle'
  | 'ped'
  | 'path';

export interface Brush {
  vehicle: VehicleType;
  ped: PedestrianType;
  sign: SignKind;
  signValue: number;
  obstacle: ObstacleKind;
  lanes: number;
  center: CenterMarking;
  oneWay: boolean;
  zone: RoadZone;
  smooth: boolean;
  sidewalkWidth: number;
  separated: boolean;
}

export const POLY_TOOLS: Tool[] = ['road', 'sidewalk', 'track'];
export const PLACE_TOOLS: Tool[] = ['crosswalk', 'light', 'sign', 'obstacle', 'vehicle', 'ped'];

type Drag =
  | { kind: 'pan'; start: Vec; cam: Camera; moved: boolean }
  | { kind: 'body'; sel: Selection; last: Vec }
  | { kind: 'vertex'; sel: Selection; index: number }
  | { kind: 'wp'; actor: string; index: number }
  | { kind: 'rot'; sel: Selection }
  | { kind: 'place'; start: Vec; angle: number; dragged: boolean }
  | { kind: 'click'; start: Vec; moved: boolean };

const CLICK_PX = 6;

export class Editor {
  tool: Tool = 'select';
  sel: Selection | null = null;
  selWp: number | null = null;
  drawing: DrawingState | null = null;
  ghost: GhostState | null = null;
  snap = true;
  readonly brush: Brush = {
    vehicle: 'car',
    ped: 'adult',
    sign: 'giveway',
    signValue: 40,
    obstacle: 'building',
    lanes: 1,
    center: 'dashed',
    oneWay: false,
    zone: 'city',
    smooth: false,
    sidewalkWidth: 3,
    separated: false,
  };

  cam: Camera = { x: 0, y: 0, s: 8 };
  /** вызывается при любом изменении сцены (в т.ч. во время перетаскивания) */
  onSceneChange: (final: boolean) => void = () => {};
  onSelect: () => void = () => {};
  onTool: () => void = () => {};
  onView: () => void = () => {};
  /** пользователь сам двигает или масштабирует карту */
  onUserCam: () => void = () => {};
  readonly locked = { value: false };

  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private pointers = new Map<number, Vec>();
  private drag: Drag | null = null;
  private pinch: { dist: number; center: Vec; cam: Camera } | null = null;
  private space = false;
  private lastCheckpoint = false;

  constructor(
    public scene: Scene,
    private canvas: HTMLCanvasElement,
    private renderer: Renderer,
  ) {
    canvas.addEventListener('pointerdown', (e) => this.pointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.pointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.pointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.pointerUp(e));
    canvas.addEventListener('dblclick', (e) => this.dblClick(e));
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    window.addEventListener('keydown', (e) => this.keyDown(e));
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.space = false;
    });
  }

  // ---- публичное API -------------------------------------------------------

  setScene(scene: Scene, keepHistory = false): void {
    if (keepHistory) this.checkpoint();
    else {
      this.undoStack = [];
      this.redoStack = [];
    }
    this.scene = scene;
    this.sel = null;
    this.selWp = null;
    this.drawing = POLY_TOOLS.includes(this.tool) ? { tool: this.tool, pts: [], cursor: null } : null;
    this.fit();
    this.onSelect();
    this.onSceneChange(true);
  }

  setTool(tool: Tool): void {
    if (this.tool === tool) return;
    this.finishDrawing();
    this.tool = tool;
    this.ghost = null;
    if (POLY_TOOLS.includes(tool)) this.drawing = { tool, pts: [], cursor: null };
    if (tool === 'path') {
      if (this.selectedActor()) this.drawing = { tool, pts: [], cursor: null };
      else {
        this.tool = 'select';
      }
    }
    this.onTool();
    this.onView();
  }

  selectedActor(): Actor | null {
    if (this.sel?.col !== 'actors') return null;
    return this.scene.actors.find((a) => a.id === this.sel!.id) ?? null;
  }

  select(sel: Selection | null, wp: number | null = null): void {
    this.sel = sel;
    this.selWp = wp;
    this.onSelect();
    this.onView();
  }

  checkpoint(): void {
    this.undoStack.push(JSON.stringify(this.scene));
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Фиксирует точку отмены один раз за жест. */
  private touch(): void {
    if (!this.lastCheckpoint) {
      this.checkpoint();
      this.lastCheckpoint = true;
    }
  }

  changed(final = true): void {
    this.onSceneChange(final);
    this.onView();
  }

  undo(): void {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(JSON.stringify(this.scene));
    this.restore(s);
  }

  redo(): void {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(JSON.stringify(this.scene));
    this.restore(s);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  private restore(json: string): void {
    this.scene = JSON.parse(json) as Scene;
    if (this.sel && !this.find(this.sel)) this.sel = null;
    this.drawing = POLY_TOOLS.includes(this.tool) ? { tool: this.tool, pts: [], cursor: null } : null;
    this.onSelect();
    this.changed(true);
  }

  find(sel: Selection): { id: string } | undefined {
    return (this.scene[sel.col] as { id: string }[]).find((x) => x.id === sel.id);
  }

  deleteSelection(): void {
    if (!this.sel) return;
    this.checkpoint();
    const { col, id } = this.sel;
    const arr = this.scene[col] as { id: string }[];
    const i = arr.findIndex((x) => x.id === id);
    if (i >= 0) arr.splice(i, 1);
    if (col === 'lights') for (const c of this.scene.crosswalks) if (c.lightId === id) delete c.lightId;
    this.sel = null;
    this.selWp = null;
    if (this.tool === 'path') this.setTool('select');
    this.onSelect();
    this.changed(true);
  }

  duplicateSelection(): void {
    if (!this.sel) return;
    const it = this.find(this.sel);
    if (!it) return;
    this.checkpoint();
    const copy = cloneScene(it) as { id: string; x?: number; y?: number; pts?: Vec[]; path?: Vec[] };
    copy.id = newId(this.scene, this.sel.col);
    const d = { x: 4, y: 4 };
    if (copy.pts) copy.pts = copy.pts.map((p) => add(p, d));
    if (copy.x !== undefined && copy.y !== undefined) {
      copy.x += d.x;
      copy.y += d.y;
    }
    if (copy.path) copy.path = copy.path.map((p) => add(p, d));
    (this.scene[this.sel.col] as unknown[]).push(copy);
    this.sel = { col: this.sel.col, id: copy.id };
    this.onSelect();
    this.changed(true);
  }

  finishDrawing(): void {
    const d = this.drawing;
    if (!d) return;
    const s = this.scene;
    if (d.tool === 'road' && d.pts.length >= 2) {
      this.checkpoint();
      const b = this.brush;
      const id = newId(s, 'roads');
      s.roads.push({ id, pts: d.pts, lanes: b.lanes, center: b.oneWay ? 'none' : b.center, oneWay: b.oneWay, zone: b.zone, smooth: b.smooth });
      this.sel = { col: 'roads', id };
    } else if (d.tool === 'sidewalk' && d.pts.length >= 2) {
      this.checkpoint();
      const id = newId(s, 'sidewalks');
      s.sidewalks.push({ id, pts: d.pts, width: this.brush.sidewalkWidth, smooth: this.brush.smooth });
      this.sel = { col: 'sidewalks', id };
    } else if (d.tool === 'track' && d.pts.length >= 2) {
      this.checkpoint();
      const id = newId(s, 'tracks');
      s.tracks.push({ id, pts: d.pts, separated: this.brush.separated, smooth: this.brush.smooth });
      this.sel = { col: 'tracks', id };
    }
    const wasPath = d.tool === 'path';
    this.drawing = POLY_TOOLS.includes(d.tool as Tool) ? { tool: d.tool, pts: [], cursor: null } : null;
    if (wasPath) {
      this.tool = 'select';
      this.onTool();
    }
    this.onSelect();
    this.changed(true);
  }

  cancelDrawing(): void {
    if (this.drawing && this.drawing.pts.length) {
      this.drawing.pts = [];
    } else if (this.tool !== 'select') {
      this.setTool('select');
    }
    this.onView();
  }

  // ---- вид -----------------------------------------------------------------

  fit(): void {
    const pts: Vec[] = [];
    const s = this.scene;
    for (const r of s.roads) pts.push(...r.pts);
    for (const r of s.sidewalks) pts.push(...r.pts);
    for (const r of s.tracks) pts.push(...r.pts);
    for (const a of s.actors) {
      pts.push({ x: a.x, y: a.y });
      for (const w of a.path) pts.push(w);
    }
    for (const it of [...s.lights, ...s.signs, ...s.crosswalks, ...s.obstacles]) pts.push({ x: it.x, y: it.y });
    if (!pts.length) {
      this.cam = { x: 0, y: 0, s: 8 };
      return;
    }
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    // подгоняем под область вокруг участников, а не под километровые дороги
    const actorPts = s.actors.flatMap((a) => [{ x: a.x, y: a.y }, ...a.path]);
    let bx0 = minX;
    let bx1 = maxX;
    let by0 = minY;
    let by1 = maxY;
    if (actorPts.length) {
      bx0 = Math.min(...actorPts.map((p) => p.x)) - 15;
      bx1 = Math.max(...actorPts.map((p) => p.x)) + 15;
      by0 = Math.min(...actorPts.map((p) => p.y)) - 15;
      by1 = Math.max(...actorPts.map((p) => p.y)) + 15;
    }
    const w = Math.max(30, bx1 - bx0);
    const h = Math.max(30, by1 - by0);
    this.cam = {
      x: (bx0 + bx1) / 2,
      y: (by0 + by1) / 2,
      s: clamp(Math.min(this.renderer.w / w, this.renderer.h / h), 1.2, 30),
    };
    this.onView();
  }

  zoomBy(f: number, around?: Vec): void {
    const c = this.cam;
    const ns = clamp(c.s * f, 0.8, 60);
    if (around) {
      const before = screenToWorld(c, this.renderer.w, this.renderer.h, around);
      c.s = ns;
      const after = screenToWorld(c, this.renderer.w, this.renderer.h, around);
      c.x += before.x - after.x;
      c.y += before.y - after.y;
    } else c.s = ns;
    this.onView();
  }

  // ---- вспомогательное -----------------------------------------------------

  private local(e: PointerEvent | WheelEvent | MouseEvent): Vec {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private world(p: Vec): Vec {
    return screenToWorld(this.cam, this.renderer.w, this.renderer.h, p);
  }

  private snapPt(p: Vec): Vec {
    if (!this.snap) return p;
    // примагничивание к концам существующих ломаных
    const tol = 12 / this.cam.s;
    let best: Vec | null = null;
    let bd = tol;
    for (const col of ['roads', 'sidewalks', 'tracks'] as const) {
      for (const it of this.scene[col]) {
        for (const q of [it.pts[0], it.pts[it.pts.length - 1]]) {
          if (!q) continue;
          const d = dist(p, q);
          if (d < bd) {
            bd = d;
            best = q;
          }
        }
      }
    }
    if (best) return { ...best };
    const g = this.cam.s >= 10 ? 0.5 : 1;
    return { x: Math.round(p.x / g) * g, y: Math.round(p.y / g) * g };
  }

  private snapAngle(a: number): number {
    if (!this.snap) return a;
    const step = rad(5);
    return Math.round(a / step) * step;
  }

  // ---- попадание -----------------------------------------------------------

  private hit(p: Vec): { sel: Selection; part: 'body' | 'rot' | 'vertex' | 'wp'; index: number } | null {
    const px = 1 / this.cam.s;
    const s = this.scene;
    // ручки выбранного объекта
    if (this.sel) {
      const it = this.find(this.sel) as Record<string, unknown> | undefined;
      if (it) {
        if ('pts' in it) {
          const pts = it.pts as Vec[];
          for (let i = 0; i < pts.length; i++) if (dist(p, pts[i]) < 14 * px) return { sel: this.sel, part: 'vertex', index: i };
        }
        if (this.sel.col === 'actors') {
          const a = it as unknown as Actor;
          for (let i = 0; i < a.path.length; i++) if (dist(p, a.path[i]) < 14 * px) return { sel: this.sel, part: 'wp', index: i };
          if (!a.path.length && dist(p, rotateHandle(a)) < 14 * px) return { sel: this.sel, part: 'rot', index: 0 };
        } else if (['crosswalks', 'lights', 'signs', 'obstacles'].includes(this.sel.col)) {
          if (dist(p, rotateHandle(it as { x: number; y: number; angle: number })) < 14 * px) return { sel: this.sel, part: 'rot', index: 0 };
        }
      }
    }
    // участники
    for (let i = s.actors.length - 1; i >= 0; i--) {
      const a = s.actors[i];
      const sp = actorSpec(a);
      const h = a.path.length ? angleOf(sub(a.path[0], a)) : a.heading;
      const m = Math.max(0.3, 8 * px - Math.min(sp.width, sp.length) / 2);
      if (pointInObb(p, { cx: a.x, cy: a.y, hl: sp.length / 2, hw: sp.width / 2, a: h }, m)) {
        return { sel: { col: 'actors', id: a.id }, part: 'body', index: 0 };
      }
    }
    for (const col of ['lights', 'signs'] as const) {
      for (const it of s[col]) if (dist(p, it) < Math.max(1.0, 12 * px)) return { sel: { col, id: it.id }, part: 'body', index: 0 };
    }
    for (const c of s.crosswalks) {
      if (pointInObb(p, { cx: c.x, cy: c.y, hl: c.length / 2, hw: c.width / 2, a: c.angle }, 4 * px)) return { sel: { col: 'crosswalks', id: c.id }, part: 'body', index: 0 };
    }
    for (const o of s.obstacles) {
      if (pointInObb(p, { cx: o.x, cy: o.y, hl: o.w / 2, hw: o.h / 2, a: o.angle }, 4 * px)) return { sel: { col: 'obstacles', id: o.id }, part: 'body', index: 0 };
    }
    const geo = buildGeo(s);
    for (const tg of geo.tracks) {
      if (tg.pts.length >= 2 && nearestOnPolyline(tg.pts, p).dist < Math.max(1.0, 8 * px)) return { sel: { col: 'tracks', id: tg.item.id }, part: 'body', index: 0 };
    }
    for (const sw of geo.sidewalks) {
      if (sw.pts.length >= 2 && nearestOnPolyline(sw.pts, p).dist < Math.max(sw.item.width / 2, 8 * px)) return { sel: { col: 'sidewalks', id: sw.item.id }, part: 'body', index: 0 };
    }
    const hits = roadsAt(geo, p, 6 * px);
    if (hits.length) return { sel: { col: 'roads', id: hits[0].rg.road.id }, part: 'body', index: 0 };
    return null;
  }

  // ---- автоориентация на дороге -------------------------------------------

  private roadFrame(p: Vec) {
    const geo = buildGeo(this.scene);
    const hits = roadsAt(geo, p, 3);
    if (!hits.length) return null;
    const h = hits[0];
    return { road: h.rg.road, half: h.rg.half, width: h.rg.width, near: h.near, angle: angleOf(h.near.tangent) };
  }

  // ---- события -------------------------------------------------------------

  private pointerDown(e: PointerEvent): void {
    this.canvas.setPointerCapture(e.pointerId);
    const sp = this.local(e);
    this.pointers.set(e.pointerId, sp);
    this.lastCheckpoint = false;

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: dist(a, b), center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, cam: { ...this.cam } };
      this.drag = null;
      return;
    }

    const w = this.world(sp);
    if (e.button === 1 || e.button === 2 || this.tool === 'pan' || this.space || this.locked.value) {
      this.drag = { kind: 'pan', start: sp, cam: { ...this.cam }, moved: false };
      return;
    }

    if (this.tool === 'select') {
      const h = this.hit(w);
      if (h) {
        if (h.part === 'rot') this.drag = { kind: 'rot', sel: h.sel };
        else if (h.part === 'vertex') this.drag = { kind: 'vertex', sel: h.sel, index: h.index };
        else if (h.part === 'wp') {
          this.selWp = h.index;
          this.drag = { kind: 'wp', actor: h.sel.id, index: h.index };
          this.onSelect();
        } else {
          if (!this.sel || this.sel.col !== h.sel.col || this.sel.id !== h.sel.id) {
            this.select(h.sel);
          }
          this.drag = { kind: 'body', sel: h.sel, last: w };
        }
      } else {
        this.drag = { kind: 'pan', start: sp, cam: { ...this.cam }, moved: false };
      }
      return;
    }

    if (PLACE_TOOLS.includes(this.tool)) {
      this.drag = { kind: 'place', start: w, angle: 0, dragged: false };
      this.ghost = { tool: this.tool, kind: this.ghostKind(), at: this.snapPt(w), angle: 0 };
      this.onView();
      return;
    }

    // ломаные и траектории: клик добавляет точку, перетаскивание двигает карту
    this.drag = { kind: 'click', start: sp, moved: false };
  }

  private ghostKind(): string {
    switch (this.tool) {
      case 'vehicle':
        return this.brush.vehicle;
      case 'ped':
        return this.brush.ped;
      default:
        return '';
    }
  }

  private pointerMove(e: PointerEvent): void {
    const sp = this.local(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, sp);

    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = dist(a, b);
      const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const f = d / this.pinch.dist;
      this.cam = { ...this.pinch.cam };
      const before = screenToWorld(this.pinch.cam, this.renderer.w, this.renderer.h, this.pinch.center);
      this.cam.s = clamp(this.pinch.cam.s * f, 0.8, 60);
      const after = screenToWorld(this.cam, this.renderer.w, this.renderer.h, c);
      this.cam.x += before.x - after.x;
      this.cam.y += before.y - after.y;
      this.onUserCam();
      this.onView();
      return;
    }

    const w = this.world(sp);
    const drag = this.drag;

    if (!drag) {
      // наведение: курсор для рисования, призрак объекта
      if (this.drawing) {
        this.drawing.cursor = this.snapPt(w);
        this.onView();
      }
      return;
    }

    switch (drag.kind) {
      case 'pan': {
        const dx = sp.x - drag.start.x;
        const dy = sp.y - drag.start.y;
        if (Math.hypot(dx, dy) > CLICK_PX) drag.moved = true;
        if (drag.moved) {
          this.cam.x = drag.cam.x - dx / drag.cam.s;
          this.cam.y = drag.cam.y - dy / drag.cam.s;
          this.onUserCam();
          this.onView();
        }
        break;
      }
      case 'click': {
        const dx = sp.x - drag.start.x;
        const dy = sp.y - drag.start.y;
        if (Math.hypot(dx, dy) > CLICK_PX) {
          // превращаем в панорамирование
          drag.moved = true;
          this.drag = { kind: 'pan', start: drag.start, cam: { ...this.cam }, moved: true };
        }
        if (this.drawing) this.drawing.cursor = this.snapPt(w);
        this.onView();
        break;
      }
      case 'place': {
        const at = this.snapPt(drag.start);
        const d = dist(w, drag.start);
        if (d > 1.2) {
          drag.dragged = true;
          drag.angle = this.snapAngle(angleOf(sub(w, drag.start)));
        }
        if (this.ghost) {
          this.ghost.at = at;
          this.ghost.angle = drag.angle;
        }
        this.onView();
        break;
      }
      case 'body': {
        this.touch();
        const d = sub(w, drag.last);
        const it = this.find(drag.sel) as Record<string, unknown> | undefined;
        if (!it) break;
        drag.last = w;
        if ('pts' in it) (it.pts as Vec[]).forEach((p, i, arr) => (arr[i] = add(p, d)));
        else {
          (it.x as number) += d.x;
          (it.y as number) += d.y;
          if (drag.sel.col === 'actors') for (const wp of (it as unknown as Actor).path) {
            wp.x += d.x;
            wp.y += d.y;
          }
        }
        this.changed(false);
        break;
      }
      case 'vertex': {
        this.touch();
        const it = this.find(drag.sel) as { pts: Vec[] } | undefined;
        if (!it) break;
        it.pts[drag.index] = this.snapPt(w);
        this.changed(false);
        break;
      }
      case 'wp': {
        this.touch();
        const a = this.scene.actors.find((x) => x.id === drag.actor);
        if (!a) break;
        const q = this.snapPt(w);
        a.path[drag.index].x = q.x;
        a.path[drag.index].y = q.y;
        this.syncHeading(a);
        this.changed(false);
        break;
      }
      case 'rot': {
        this.touch();
        const it = this.find(drag.sel) as Record<string, number> | undefined;
        if (!it) break;
        const ang = this.snapAngle(angleOf(sub(w, { x: it.x, y: it.y })));
        if (drag.sel.col === 'actors') it.heading = ang;
        else it.angle = ang;
        this.changed(false);
        break;
      }
    }
  }

  private pointerUp(e: PointerEvent): void {
    const sp = this.local(e);
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      this.drag = null;
      return;
    }
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    const w = this.world(sp);

    switch (drag.kind) {
      case 'pan':
        if (!drag.moved && this.tool === 'select') this.select(null);
        break;
      case 'click':
        if (!drag.moved) this.addPoint(this.snapPt(w));
        break;
      case 'place':
        this.place(this.snapPt(drag.start), drag.dragged ? drag.angle : null);
        this.ghost = null;
        break;
      case 'body':
      case 'vertex':
      case 'wp':
      case 'rot':
        this.changed(true);
        this.onSelect();
        break;
    }
    this.lastCheckpoint = false;
    this.onView();
  }

  private dblClick(e: MouseEvent): void {
    const w = this.world(this.local(e));
    if (this.drawing && this.drawing.pts.length) {
      // двойной клик добавил лишнюю точку в первом клике — убираем дубль и завершаем
      const pts = this.drawing.pts;
      if (pts.length >= 2 && dist(pts[pts.length - 1], pts[pts.length - 2]) < 0.6) pts.pop();
      this.finishDrawing();
      return;
    }
    if (this.tool !== 'select' || !this.sel) return;
    const it = this.find(this.sel) as { pts?: Vec[] } | undefined;
    if (!it?.pts) return;
    const px = 1 / this.cam.s;
    const pts = it.pts;
    // двойной клик по вершине — удалить, по отрезку — добавить вершину
    const vi = pts.findIndex((q) => dist(q, w) < 12 * px);
    this.checkpoint();
    if (vi >= 0) {
      if (pts.length > 2) pts.splice(vi, 1);
    } else {
      let bi = -1;
      let bd = 12 * px;
      for (let i = 0; i < pts.length - 1; i++) {
        const d = distToSegment(w, pts[i], pts[i + 1]);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      if (bi >= 0) pts.splice(bi + 1, 0, this.snapPt(w));
    }
    this.changed(true);
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    this.onUserCam();
    this.zoomBy(Math.exp(-e.deltaY * 0.0015), this.local(e));
  }

  private keyDown(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (this.locked.value) return;
    if (e.code === 'Space') {
      this.space = true;
      e.preventDefault();
    } else if (e.key === 'Escape') this.cancelDrawing();
    else if (e.key === 'Enter') this.finishDrawing();
    else if (e.key === 'Delete' || e.key === 'Backspace') this.deleteSelection();
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      this.redo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      this.duplicateSelection();
    }
  }

  // ---- добавление точек и объектов ----------------------------------------

  private addPoint(p: Vec): void {
    const d = this.drawing;
    if (!d) {
      return;
    }
    if (d.tool === 'path') {
      const a = this.selectedActor();
      if (!a) return;
      this.checkpoint();
      const last = a.path[a.path.length - 1];
      a.path.push({ x: p.x, y: p.y, v: last ? last.v : a.speed });
      this.syncHeading(a);
      this.selWp = a.path.length - 1;
      this.changed(true);
      this.onSelect();
      return;
    }
    d.pts.push(p);
    this.onView();
    this.onTool();
  }

  /** Курс участника с траекторией всегда направлен на первую точку. */
  syncHeading(a: Actor): void {
    if (a.path.length) a.heading = angleOf(sub(a.path[0], a));
  }

  private place(at: Vec, angle: number | null): void {
    const s = this.scene;
    this.checkpoint();
    const t = this.tool;
    const frame = this.roadFrame(at);
    let id = '';
    let col: Collection = 'actors';
    if (t === 'vehicle') {
      const spec = VEHICLES[this.brush.vehicle];
      let pos = at;
      let heading = angle ?? 0;
      if (angle === null && frame && !frame.road.oneWay) {
        // встаём в центр полосы по ходу движения
        const fwd = frame.near.d >= 0;
        const lane = clamp(Math.floor(Math.abs(frame.near.d) / LANE_WIDTH), 0, frame.road.lanes - 1);
        const lateral = (lane + 0.5) * LANE_WIDTH;
        heading = fwd ? frame.angle : frame.angle + Math.PI;
        const rightVec = rightOf(frame.angle);
        pos = add(frame.near.point, mul(rightVec, fwd ? lateral : -lateral));
      } else if (angle === null && frame) {
        const lane = clamp(Math.floor((frame.near.d + frame.half) / LANE_WIDTH), 0, frame.road.lanes - 1);
        heading = frame.angle;
        pos = add(frame.near.point, mul(rightOf(frame.angle), -frame.half + (lane + 0.5) * LANE_WIDTH));
      }
      id = newId(s, 'actors');
      const idx = s.actors.filter((a) => a.kind === 'vehicle').length;
      s.actors.push({
        id,
        kind: 'vehicle',
        type: this.brush.vehicle,
        x: pos.x,
        y: pos.y,
        heading: wrapAngle(heading),
        color: idx > 0 && idx < 6 ? ['#3e9bff', '#e5484d', '#2fb36b', '#f5a524', '#8b6fe8', '#35b6c4'][idx] : spec.color,
        speed: spec.rail ? 30 : 40,
        delay: 0,
        path: [],
        flags: { drunk: false, noLicense: false, flees: false },
      });
    } else if (t === 'ped') {
      id = newId(s, 'actors');
      const ps = PEDESTRIANS[this.brush.ped];
      s.actors.push({
        id,
        kind: 'pedestrian',
        type: this.brush.ped,
        x: at.x,
        y: at.y,
        heading: angle ?? Math.PI / 2,
        color: ps.color,
        speed: ps.speed,
        delay: 0,
        path: [],
        flags: { drunk: false, noLicense: false, flees: false },
      });
    } else if (t === 'crosswalk') {
      id = newId(s, 'crosswalks');
      col = 'crosswalks';
      let ang = angle ?? 0;
      let pos = at;
      let length = 8;
      if (angle === null && frame) {
        pos = frame.near.point;
        ang = frame.angle + Math.PI / 2;
        length = frame.width + 1.5;
      }
      s.crosswalks.push({ id, x: pos.x, y: pos.y, angle: wrapAngle(ang), length, width: 4 });
    } else if (t === 'light') {
      id = newId(s, 'lights');
      col = 'lights';
      let pos = at;
      let ang = angle ?? 0;
      let len = 3.5;
      if (angle === null && frame) {
        const fwd = frame.road.oneWay ? true : frame.near.d >= 0;
        ang = fwd ? frame.angle : frame.angle + Math.PI;
        pos = add(frame.near.point, mul(rightOf(frame.angle), fwd ? frame.half : -frame.half));
        len = frame.road.oneWay ? frame.width : frame.half;
      }
      s.lights.push({ id, x: pos.x, y: pos.y, angle: wrapAngle(ang), lineLength: len, green: 10, yellow: 3, red: 12, offset: 0 });
    } else if (t === 'sign') {
      id = newId(s, 'signs');
      col = 'signs';
      let pos = at;
      let ang = angle ?? 0;
      if (angle === null && frame) {
        const fwd = frame.road.oneWay ? true : frame.near.d >= 0;
        ang = fwd ? frame.angle : frame.angle + Math.PI;
        pos = add(frame.near.point, mul(rightOf(frame.angle), fwd ? frame.half + 0.8 : -(frame.half + 0.8)));
      }
      s.signs.push({ id, x: pos.x, y: pos.y, angle: wrapAngle(ang), kind: this.brush.sign, value: this.brush.sign === 'limit' ? this.brush.signValue : undefined });
    } else if (t === 'obstacle') {
      id = newId(s, 'obstacles');
      col = 'obstacles';
      const sizes: Record<ObstacleKind, [number, number]> = { building: [12, 8], fence: [8, 0.4], tree: [2.2, 2.2], barrier: [3, 0.8] };
      const [w, h] = sizes[this.brush.obstacle];
      s.obstacles.push({ id, x: at.x, y: at.y, w, h, angle: angle ?? 0, kind: this.brush.obstacle });
    }
    this.sel = { col, id };
    this.selWp = null;
    this.tool = 'select';
    this.onTool();
    this.onSelect();
    this.changed(true);
  }
}
