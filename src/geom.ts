// Геометрия сцены. Единицы: метры и радианы. Ось Y направлена вниз (как на экране),
// поэтому «вправо по ходу движения» для направления a — это вектор (-sin a, cos a).

export interface Vec {
  x: number;
  y: number;
}

export const vec = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Vec, b: Vec, t: number): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const fromAngle = (a: number): Vec => ({ x: Math.cos(a), y: Math.sin(a) });
export const angleOf = (a: Vec): number => Math.atan2(a.y, a.x);
export const rightOf = (a: number): Vec => ({ x: -Math.sin(a), y: Math.cos(a) });
export const norm = (a: Vec): Vec => {
  const l = len(a);
  return l < 1e-9 ? { x: 1, y: 0 } : { x: a.x / l, y: a.y / l };
};

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const deg = (rad: number): number => (rad * 180) / Math.PI;
export const rad = (d: number): number => (d * Math.PI) / 180;
export const kmh = (ms: number): number => ms * 3.6;
export const ms = (kmhv: number): number => kmhv / 3.6;

/** Приводит угол к диапазону (-π, π]. */
export function wrapAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  if (r <= -Math.PI) r += 2 * Math.PI;
  return r;
}

/** Знаковая разность углов b − a в (-π, π]; положительная — поворот по часовой стрелке на экране (вправо). */
export const angDiff = (a: number, b: number): number => wrapAngle(b - a);

// ---------------------------------------------------------------------------
// Ориентированные прямоугольники (кузова) и столкновения

export interface OBB {
  cx: number;
  cy: number;
  /** полудлина вдоль направления a */
  hl: number;
  /** полуширина */
  hw: number;
  a: number;
}

export function obbCorners(o: OBB): Vec[] {
  const f = fromAngle(o.a);
  const r = rightOf(o.a);
  const c = { x: o.cx, y: o.cy };
  return [
    add(add(c, mul(f, o.hl)), mul(r, -o.hw)), // 0 передний левый
    add(add(c, mul(f, o.hl)), mul(r, o.hw)), // 1 передний правый
    add(add(c, mul(f, -o.hl)), mul(r, o.hw)), // 2 задний правый
    add(add(c, mul(f, -o.hl)), mul(r, -o.hw)), // 3 задний левый
  ];
}

export function pointInObb(p: Vec, o: OBB, margin = 0): boolean {
  const l = toLocal(p, o);
  return Math.abs(l.x) <= o.hl + margin && Math.abs(l.y) <= o.hw + margin;
}

/** Координаты точки в системе кузова: x — вперёд, y — вправо. */
export function toLocal(p: Vec, o: { cx: number; cy: number; a: number }): Vec {
  const d = { x: p.x - o.cx, y: p.y - o.cy };
  return { x: dot(d, fromAngle(o.a)), y: dot(d, rightOf(o.a)) };
}

export interface Contact {
  /** единичная нормаль, направленная от A к B */
  n: Vec;
  depth: number;
  point: Vec;
}

function project(corners: Vec[], axis: Vec): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of corners) {
    const p = dot(c, axis);
    if (p < lo) lo = p;
    if (p > hi) hi = p;
  }
  return [lo, hi];
}

/**
 * Тест пересечения двух прямоугольников по теореме о разделяющей оси.
 * Если известна относительная скорость A относительно B, нормаль выбирается по грани, которой
 * тела коснулись первыми, — иначе при быстром сближении касание углом даёт «боковую» нормаль.
 */
export function obbContact(A: OBB, B: OBB, relVel?: Vec): Contact | null {
  const ca = obbCorners(A);
  const cb = obbCorners(B);
  const axes = [fromAngle(A.a), rightOf(A.a), fromAngle(B.a), rightOf(B.a)];
  const dc = { x: B.cx - A.cx, y: B.cy - A.cy };
  const cands: { n: Vec; depth: number; approach: number }[] = [];
  let minDepth = Infinity;
  let minAxis = axes[0];
  for (const ax of axes) {
    const [a0, a1] = project(ca, ax);
    const [b0, b1] = project(cb, ax);
    const overlap = Math.min(a1, b1) - Math.max(a0, b0);
    if (overlap <= 0) return null;
    const n = dot(dc, ax) >= 0 ? ax : mul(ax, -1);
    cands.push({ n, depth: overlap, approach: relVel ? dot(relVel, n) : 0 });
    if (overlap < minDepth) {
      minDepth = overlap;
      minAxis = n;
    }
  }
  let n = minAxis;
  let depth = minDepth;
  if (relVel) {
    const moving = cands.filter((c) => c.approach > 0.05);
    if (moving.length) {
      const tOf = (c: { depth: number; approach: number }) => c.depth / c.approach;
      const tMin = Math.min(...moving.map(tOf));
      const near = moving.filter((c) => tOf(c) <= tMin * 1.6 + 0.01);
      const pick = near.reduce((m, c) => (c.approach > m.approach ? c : m));
      n = pick.n;
      depth = pick.depth;
    }
  }
  const inside: Vec[] = [];
  for (const c of ca) if (pointInObb(c, B)) inside.push(c);
  for (const c of cb) if (pointInObb(c, A)) inside.push(c);
  let point: Vec;
  if (inside.length) {
    point = mul(
      inside.reduce((s, p) => add(s, p), { x: 0, y: 0 }),
      1 / inside.length,
    );
  } else {
    point = { x: (A.cx + B.cx) / 2, y: (A.cy + B.cy) / 2 };
  }
  return { n, depth, point };
}

// ---------------------------------------------------------------------------
// Отрезки и ломаные

/** Пересечение отрезков p1-p2 и q1-q2; возвращает параметры вдоль каждого. */
export function segIntersect(p1: Vec, p2: Vec, q1: Vec, q2: Vec): { t: number; u: number } | null {
  const r = sub(p2, p1);
  const s = sub(q2, q1);
  const den = cross(r, s);
  if (Math.abs(den) < 1e-12) return null;
  const qp = sub(q1, p1);
  const t = cross(qp, s) / den;
  const u = cross(qp, r) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

export function polylineLength(pts: Vec[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
}

export interface NearestInfo {
  /** индекс сегмента */
  i: number;
  point: Vec;
  /** расстояние до ломаной */
  dist: number;
  /** единичный вектор направления сегмента */
  tangent: Vec;
  /** смещение от оси; положительное — справа по направлению ломаной */
  d: number;
  /** расстояние вдоль ломаной от начала */
  s: number;
  /** проекция попала за начало или конец ломаной */
  beyond: boolean;
}

export function nearestOnPolyline(pts: Vec[], p: Vec): NearestInfo {
  let best: NearestInfo | null = null;
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const ab = sub(b, a);
    const l2 = dot(ab, ab);
    const segLen = Math.sqrt(l2);
    let t = l2 < 1e-12 ? 0 : dot(sub(p, a), ab) / l2;
    const raw = t;
    t = clamp(t, 0, 1);
    const q = { x: a.x + ab.x * t, y: a.y + ab.y * t };
    const dd = dist(p, q);
    if (!best || dd < best.dist) {
      const tan = norm(ab);
      const r = rightOf(angleOf(tan));
      const beyond = (i === 0 && raw < 0) || (i === pts.length - 2 && raw > 1);
      best = { i, point: q, dist: dd, tangent: tan, d: dot(sub(p, q), r), s: acc + segLen * t, beyond };
    }
    acc += segLen;
  }
  if (!best) {
    const q = pts[0] ?? { x: 0, y: 0 };
    return { i: 0, point: q, dist: dist(p, q), tangent: { x: 1, y: 0 }, d: 0, s: 0, beyond: true };
  }
  return best;
}

/** Центростремительный сплайн Catmull–Rom через заданные точки (проходит ровно через них). */
export function smoothPolyline(pts: Vec[], perSeg = 10): { pts: Vec[]; nodeIdx: number[] } {
  if (pts.length < 3) return { pts: pts.slice(), nodeIdx: pts.map((_, i) => i) };
  const out: Vec[] = [];
  const nodeIdx: number[] = [];
  const P = (i: number): Vec => pts[Math.max(0, Math.min(pts.length - 1, i))];
  const tj = (ti: number, a: Vec, b: Vec) => ti + Math.max(Math.sqrt(dist(a, b)), 1e-4);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = i === 0 ? sub(mul(pts[0], 2), pts[1]) : P(i - 1);
    const p1 = P(i);
    const p2 = P(i + 1);
    const p3 = i + 2 >= pts.length ? sub(mul(pts[pts.length - 1], 2), pts[pts.length - 2]) : P(i + 2);
    const t0 = 0;
    const t1 = tj(t0, p0, p1);
    const t2 = tj(t1, p1, p2);
    const t3 = tj(t2, p2, p3);
    nodeIdx.push(out.length);
    for (let k = 0; k < perSeg; k++) {
      const t = t1 + ((t2 - t1) * k) / perSeg;
      const A1 = add(mul(p0, (t1 - t) / (t1 - t0)), mul(p1, (t - t0) / (t1 - t0)));
      const A2 = add(mul(p1, (t2 - t) / (t2 - t1)), mul(p2, (t - t1) / (t2 - t1)));
      const A3 = add(mul(p2, (t3 - t) / (t3 - t2)), mul(p3, (t - t2) / (t3 - t2)));
      const B1 = add(mul(A1, (t2 - t) / (t2 - t0)), mul(A2, (t - t0) / (t2 - t0)));
      const B2 = add(mul(A2, (t3 - t) / (t3 - t1)), mul(A3, (t - t1) / (t3 - t1)));
      out.push(add(mul(B1, (t2 - t) / (t2 - t1)), mul(B2, (t - t1) / (t2 - t1))));
    }
  }
  nodeIdx.push(out.length);
  out.push(pts[pts.length - 1]);
  return { pts: out, nodeIdx };
}

/** Путь с параметризацией по длине дуги. */
export interface PathData {
  pts: Vec[];
  cum: number[];
  total: number;
  /** длина дуги до каждой исходной точки */
  nodeS: number[];
}

export function buildPath(ctrl: Vec[], smooth = true): PathData {
  const sm = smooth ? smoothPolyline(ctrl) : { pts: ctrl.slice(), nodeIdx: ctrl.map((_, i) => i) };
  const pts = sm.pts;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  return { pts, cum, total: cum[cum.length - 1], nodeS: sm.nodeIdx.map((i) => cum[i]) };
}

function segIndex(cum: number[], s: number): number {
  let lo = 0;
  let hi = cum.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

/** Положение и курс на расстоянии s по пути; за концом — продолжение по прямой. */
export function pathAt(path: PathData, s: number): { p: Vec; a: number } {
  const pts = path.pts;
  if (pts.length < 2) return { p: pts[0] ?? { x: 0, y: 0 }, a: 0 };
  if (s <= 0) {
    const d = norm(sub(pts[1], pts[0]));
    return { p: add(pts[0], mul(d, s)), a: angleOf(d) };
  }
  if (s >= path.total) {
    const d = norm(sub(pts[pts.length - 1], pts[pts.length - 2]));
    return { p: add(pts[pts.length - 1], mul(d, s - path.total)), a: angleOf(d) };
  }
  const i = segIndex(path.cum, s);
  const segLen = path.cum[i + 1] - path.cum[i];
  const t = segLen < 1e-9 ? 0 : (s - path.cum[i]) / segLen;
  const d = sub(pts[i + 1], pts[i]);
  return { p: lerp(pts[i], pts[i + 1], t), a: angleOf(d) };
}

/** Расстояние от точки до отрезка. */
export function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 < 1e-12 ? 0 : clamp(dot(sub(p, a), ab) / l2, 0, 1);
  return dist(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
}

/**
 * Скругляет углы ломаной дугами заданного радиуса (в метрах).
 * Радиус автоматически уменьшается, если соседние отрезки слишком коротки.
 */
export function filletPolyline(pts: Vec[], radius: number, steps = 12): Vec[] {
  if (pts.length < 3 || radius <= 0.05) return pts.slice();
  const out: Vec[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const v = pts[i];
    const toPrev = sub(pts[i - 1], v);
    const toNext = sub(pts[i + 1], v);
    const lp = len(toPrev);
    const ln = len(toNext);
    if (lp < 1e-6 || ln < 1e-6) {
      out.push(v);
      continue;
    }
    const a = mul(toPrev, 1 / lp);
    const b = mul(toNext, 1 / ln);
    const cosInt = clamp(dot(a, b), -1, 1);
    const interior = Math.acos(cosInt); // угол между отрезками
    if (interior > Math.PI - 0.02 || interior < 0.02) {
      out.push(v); // почти прямая или разворот на месте
      continue;
    }
    // длина касательной от вершины до начала дуги
    let t = radius / Math.tan(interior / 2);
    t = Math.min(t, lp * 0.5, ln * 0.5);
    const p0 = add(v, mul(a, t));
    const p1 = add(v, mul(b, t));
    for (let k = 0; k <= steps; k++) {
      const u = k / steps;
      // квадратичная кривая Безье с управляющей точкой в вершине даёт гладкую дугу
      const x = (1 - u) * (1 - u) * p0.x + 2 * (1 - u) * u * v.x + u * u * p1.x;
      const y = (1 - u) * (1 - u) * p0.y + 2 * (1 - u) * u * v.y + u * u * p1.y;
      out.push({ x, y });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Точка и курс на расстоянии s вдоль ломаной с заранее посчитанными накопленными длинами. */
export function frameAtStation(pts: Vec[], cum: number[], s: number): { p: Vec; a: number } {
  if (pts.length < 2) return { p: pts[0] ?? { x: 0, y: 0 }, a: 0 };
  const total = cum[cum.length - 1];
  const ss = clamp(s, 0, total);
  let lo = 0;
  let hi = cum.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= ss) lo = mid;
    else hi = mid - 1;
  }
  const seg = cum[lo + 1] - cum[lo];
  const t = seg < 1e-9 ? 0 : (ss - cum[lo]) / seg;
  return { p: lerp(pts[lo], pts[lo + 1], t), a: angleOf(sub(pts[lo + 1], pts[lo])) };
}
