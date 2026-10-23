import type { ParameterSource } from './types';
import { finite } from './parameters';

/** Planar vector, m or m/s or N s depending on use. */
export interface V2 { x: number; y: number }

/**
 * Rigid body at the instant of contact. Use Infinity for a fixed obstacle
 * (mass) or for a body whose rotation is not modelled (yawInertia), e.g. a
 * pedestrian treated as a particle. Heading is needed only for PDOF.
 */
export interface ImpactBody {
  mass: number;
  yawInertia: number;
  position: V2;
  velocity: V2;
  yawRate: number;
  heading?: number;
}

export interface ImpactInput {
  a: ImpactBody;
  b: ImpactBody;
  /** Contact point (impulse centre), world m. */
  point: V2;
  /** Unit normal of the contact plane, pointing from A to B. */
  normal: V2;
  /** Newton restitution on the normal relative velocity of the contact point, 0..1. */
  restitution: number;
  /** Coulomb limit in the contact plane; undefined = full (sticking) tangential impulse. */
  contactFriction?: number;
}

export interface ImpactBodyResult {
  /** Velocity change of the centre of mass, m/s, and its magnitude. */
  deltaV: V2;
  deltaVMagnitude: number;
  deltaYawRate: number;
  velocity: V2;
  yawRate: number;
  /**
   * Principal direction of force: direction FROM WHICH the impulse acts on this
   * body, in its body frame, degrees in (-180, 180], 0 = from the front,
   * positive clockwise (from the right side); clock 12 = front, 3 = right.
   * Undefined without heading or impulse.
   */
  pdofDeg?: number;
  clock?: number;
}

export interface ImpactResult {
  method: 'planar-rigid-impulse-newton-coulomb-v1';
  mode: 'full' | 'sliding' | 'separating';
  /** Impulse acting on B (A receives the opposite), N s, with normal/tangent parts. */
  impulse: V2;
  normalImpulse: number;
  tangentialImpulse: number;
  /** Tangential/normal ratio the full impact would need (Brach's critical ratio). */
  criticalRatio: number | null;
  /** Normal approach speed (>0 approaching) and tangential slip of the contact point, m/s. */
  approachSpeed: number;
  tangentialSpeed: number;
  separationSpeed: number;
  tangent: V2;
  a: ImpactBodyResult;
  b: ImpactBodyResult;
  energyBefore: number;
  energyAfter: number;
  /** E_loss = Pn*(un+un')/2 + Pt*(ut+ut')/2: normal (deformation) + contact-plane friction parts, J. */
  energyLoss: number;
  energyNormal: number;
  energyTangential: number;
  /** True if the chosen restitution/friction would add energy (reported, never hidden). */
  energyIncrease: boolean;
  formulas: Record<string, string>;
  units: Record<string, string>;
  sources: ParameterSource[];
  assumptions: string[];
}

const perp = (r: V2): V2 => ({ x: -r.y, y: r.x });
const dot = (a: V2, b: V2): number => a.x * b.x + a.y * b.y;
const cross = (a: V2, b: V2): number => a.x * b.y - a.y * b.x;
const inv = (x: number): number => (Number.isFinite(x) ? 1 / x : 0);

export const IMPACT_SOURCES: ParameterSource[] = [{
  kind: 'reference',
  description: 'Плоский удар твёрдых тел: импульс в точке, восстановление Ньютона по нормали, ограничение Кулона в плоскости контакта, критическое отношение импульсов (тип модели Brach, Mechanical Impact Dynamics, 1991). Уравнения выведены здесь из законов импульса и момента импульса; постраничная сверка с источником — TODO(source-check). Соответствие модели Kudlich–Slibar не заявляется.',
}];

function bodyEnergy(b: ImpactBody, v: V2, w: number): number {
  return (Number.isFinite(b.mass) ? b.mass * dot(v, v) / 2 : 0) + (Number.isFinite(b.yawInertia) ? b.yawInertia * w * w / 2 : 0);
}

function validateBody(b: ImpactBody, name: string): void {
  if (!(b.mass > 0) || !(b.yawInertia > 0) || Number.isNaN(b.mass) || Number.isNaN(b.yawInertia)) throw new Error(`Удар: ${name}: масса и момент инерции > 0 (Infinity допустим)`);
  for (const [k, v] of Object.entries({ px: b.position.x, py: b.position.y, vx: b.velocity.x, vy: b.velocity.y, w: b.yawRate })) finite(v, `${name}.${k}`);
  // Infinite mass with nonzero velocity = prescribed motion (e.g. a tram held on rails); it does work.
  if (b.heading !== undefined) finite(b.heading, `${name}.heading`);
}

function pdof(body: ImpactBody, force: V2): { pdofDeg?: number; clock?: number } {
  if (body.heading === undefined || !(force.x || force.y)) return {};
  // Direction from which the force comes = -force; express in the body frame.
  const from = Math.atan2(-force.y, -force.x) - body.heading;
  let deg = from * 180 / Math.PI;
  deg = ((deg + 180) % 360 + 360) % 360 - 180;
  if (deg === -180) deg = 180;
  const clock = ((Math.round(deg / 30) % 12) + 12) % 12 || 12;
  return { pdofDeg: deg, clock };
}

/**
 * Planar impulse between two rigid bodies.
 * u = vA + wA x rA - (vB + wB x rB);  u' = u - K P;  K = KA + KB,
 * Ki = I/mi + perp(ri) perp(ri)^T / Izi (P acts on B, -P on A).
 * Full: u'n = -k un, u't = 0. If |Pt| > muC*Pn: sliding P = Pn (n + muC sgn(ut) t),
 * Pn = (1+k) un / (n^T K (n + muC sgn(ut) t)).
 */
export function planarImpact(input: ImpactInput): ImpactResult {
  const { a, b, point, restitution: k } = input;
  validateBody(a, 'A'); validateBody(b, 'B');
  finite(point.x, 'point.x'); finite(point.y, 'point.y');
  finite(k, 'restitution', 0, 1);
  if (input.contactFriction !== undefined) finite(input.contactFriction, 'contactFriction', 0, 10);
  const nl = Math.hypot(input.normal.x, input.normal.y);
  if (!(nl > 0) || !Number.isFinite(nl)) throw new Error('Удар: нормаль не определена');
  if (!Number.isFinite(a.mass) && !Number.isFinite(b.mass)) throw new Error('Удар: оба тела неподвижны');
  const n = { x: input.normal.x / nl, y: input.normal.y / nl }, t = perp(n);
  const rA = { x: point.x - a.position.x, y: point.y - a.position.y };
  const rB = { x: point.x - b.position.x, y: point.y - b.position.y };
  const vcA = { x: a.velocity.x - a.yawRate * rA.y, y: a.velocity.y + a.yawRate * rA.x };
  const vcB = { x: b.velocity.x - b.yawRate * rB.y, y: b.velocity.y + b.yawRate * rB.x };
  const u = { x: vcA.x - vcB.x, y: vcA.y - vcB.y };
  const un = dot(u, n), ut = dot(u, t);
  const imA = inv(a.mass), imB = inv(b.mass), iiA = inv(a.yawInertia), iiB = inv(b.yawInertia);
  const pA = perp(rA), pB = perp(rB);
  // K in the (n, t) basis.
  const kk = (e1: V2, e2: V2): number => (imA + imB) * dot(e1, e2) + iiA * dot(pA, e1) * dot(pA, e2) + iiB * dot(pB, e1) * dot(pB, e2);
  const Knn = kk(n, n), Knt = kk(n, t), Ktt = kk(t, t);
  const eBefore = bodyEnergy(a, a.velocity, a.yawRate) + bodyEnergy(b, b.velocity, b.yawRate);
  let mode: ImpactResult['mode'] = 'separating';
  let Pn = 0, Pt = 0, critical: number | null = null;
  if (un > 0) {
    // Solve K [Pn, Pt] = [(1+k) un, ut].
    const det = Knn * Ktt - Knt * Knt;
    const wn = (1 + k) * un, wt = ut;
    Pn = (Ktt * wn - Knt * wt) / det;
    Pt = (Knn * wt - Knt * wn) / det;
    critical = Pn > 0 ? Math.abs(Pt) / Pn : null;
    mode = 'full';
    const mu = input.contactFriction;
    if (mu !== undefined && (Pn <= 0 || Math.abs(Pt) > mu * Pn)) {
      const s = Math.sign(ut) || 0;
      const denom = Knn + mu * s * Knt;
      if (denom > 0) {
        Pn = wn / denom;
        Pt = mu * s * Pn;
        mode = 'sliding';
      }
    }
  }
  const P = { x: Pn * n.x + Pt * t.x, y: Pn * n.y + Pt * t.y };
  const dvA = { x: -P.x * imA, y: -P.y * imA }, dvB = { x: P.x * imB, y: P.y * imB };
  const dwA = -cross(rA, P) * iiA, dwB = cross(rB, P) * iiB;
  const vA = { x: a.velocity.x + dvA.x, y: a.velocity.y + dvA.y }, vB = { x: b.velocity.x + dvB.x, y: b.velocity.y + dvB.y };
  const wA = a.yawRate + dwA, wB = b.yawRate + dwB;
  const eAfter = bodyEnergy(a, vA, wA) + bodyEnergy(b, vB, wB);
  const u2n = un - (Knn * Pn + Knt * Pt), u2t = ut - (Knt * Pn + Ktt * Pt);
  const eNormal = Pn * (un + u2n) / 2, eTangential = Pt * (ut + u2t) / 2;
  const loss = eBefore - eAfter;
  return {
    method: 'planar-rigid-impulse-newton-coulomb-v1', mode, impulse: P, normalImpulse: Pn, tangentialImpulse: Pt,
    criticalRatio: critical, approachSpeed: un, tangentialSpeed: ut, separationSpeed: -u2n, tangent: t,
    a: { deltaV: dvA, deltaVMagnitude: Math.hypot(dvA.x, dvA.y), deltaYawRate: dwA, velocity: vA, yawRate: wA, ...pdof(a, { x: -P.x, y: -P.y }) },
    b: { deltaV: dvB, deltaVMagnitude: Math.hypot(dvB.x, dvB.y), deltaYawRate: dwB, velocity: vB, yawRate: wB, ...pdof(b, P) },
    energyBefore: eBefore, energyAfter: eAfter, energyLoss: loss, energyNormal: eNormal, energyTangential: eTangential,
    energyIncrease: loss < -1e-9 * Math.max(1, eBefore),
    formulas: {
      contactVelocity: 'u = vA + wA×rA − (vB + wB×rB), w×r = w·(−ry, rx)',
      mobility: 'K = (1/mA+1/mB)·I + perp(rA)perp(rA)ᵀ/IzA + perp(rB)perp(rB)ᵀ/IzB',
      full: 'K·P = [(1+k)·un, ut] in (n,t): un\' = −k·un, ut\' = 0',
      sliding: 'P = Pn·(n + μc·sgn(ut)·t), Pn = (1+k)·un / (nᵀK(n + μc·sgn(ut)·t))',
      update: 'ΔvA = −P/mA, ΔvB = P/mB, ΔwA = −(rA×P)/IzA, ΔwB = (rB×P)/IzB',
      energy: 'E_loss = Pn(un+un\')/2 + Pt(ut+ut\')/2 = E_before − E_after',
    },
    units: { impulse: 'N s', velocity: 'm/s', yawRate: 'rad/s', energy: 'J', angle: 'deg' },
    sources: IMPACT_SOURCES.map(s => ({ ...s })),
    assumptions: [
      'Мгновенный удар: за время контакта положения не меняются, силы шин и дороги пренебрежимы по сравнению с ударным импульсом.',
      'Точка и плоскость контакта заданы геометрией/пользователем; деформация кузова не моделируется, только её энергетический итог.',
      ...(input.contactFriction === undefined ? ['Полный удар: в плоскости контакта относительное скольжение точки удара прекращается (μc не ограничивает).'] : []),
    ],
  };
}
