import type {
  EvidenceObservation,
  JsonObject,
  ProjectEnvelope,
} from '../parallel/contracts';
import { dm } from '../dmath';
export const EVIDENCE_KINDS = {
  braking: 'След торможения',
  skid: 'Юз',
  lateral: 'Занос',
  debris: 'Осыпь',
  fluid: 'Жидкость',
  gouge: 'Задир',
  impact: 'Место удара',
  'final-vehicle': 'Конечная поза ТС',
  'final-body': 'Положение тела',
  crush: 'Деформации C1–C6',
  sign: 'Знак / разметка',
  signal: 'Сигнал / цикл',
};
export interface Point {
  x: number;
  y: number;
}
export const pointsOf = (e: EvidenceObservation): Point[] =>
  Array.isArray(e.geometry.points)
    ? e.geometry.points.filter(
        (p): p is { x: number; y: number } =>
          !!p &&
          typeof p === 'object' &&
          !Array.isArray(p) &&
          typeof p.x === 'number' &&
          Number.isFinite(p.x) &&
          typeof p.y === 'number' &&
          Number.isFinite(p.y),
      )
    : [];
export function evidenceIssues(
  project: ProjectEnvelope,
  computed: EvidenceObservation[] = [],
): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const e of project.evidence) {
    if (ids.has(e.id)) issues.push(`${e.id}: повторный ID`);
    ids.add(e.id);
    if (!e.source?.trim()) issues.push(`${e.id}: не указан источник`);
    if (!e.uncertainty || e.uncertainty.metres === undefined)
      issues.push(`${e.id}: неизвестна погрешность, м`);
    else if (
      typeof e.uncertainty.metres !== 'number' ||
      e.uncertainty.metres < 0
    )
      issues.push(`${e.id}: неверная погрешность`);
    if (!pointsOf(e).length) issues.push(`${e.id}: нет геометрии`);
    if (
      e.kind === 'impact' &&
      (!e.values.establishedBy || e.values.confidence === undefined)
    )
      issues.push(`${e.id}: укажите кем установлено и уверенность`);
    if (typeof e.values.width === 'number' && e.values.width <= 0)
      issues.push(`${e.id}: ширина должна быть положительной`);
    if (e.kind === 'crush')
      for (let i = 1; i <= 6; i++)
        if (typeof e.values[`C${i}`] !== 'number')
          issues.push(`${e.id}: C${i} не измерено`);
    const other = computed.find(
      (c) => c.values.evidenceId === e.id || c.id === e.id,
    );
    if (other) {
      const a = pointsOf(e)[0],
        b = pointsOf(other)[0];
      const sigma = Number(e.uncertainty?.metres);
      if (
        a &&
        b &&
        Number.isFinite(sigma) &&
        dm.hypot(a.x - b.x, a.y - b.y) > sigma
      )
        issues.push(
          `${e.id}: модель расходится с измерением более чем на указанную погрешность; наблюдение сохранено`,
        );
    }
  }
  return issues;
}
export function newEvidence(
  kind: keyof typeof EVIDENCE_KINDS,
  points: Point[],
  values: JsonObject,
  source: string,
  metres?: number,
): EvidenceObservation {
  if (
    !points.length ||
    points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))
  )
    throw new Error('Нужны измеренные координаты');
  return {
    id: crypto.randomUUID(),
    kind,
    geometry: { points: points.map((p) => ({ ...p })) },
    values,
    source,
    ...(metres === undefined ? {} : { uncertainty: { metres } }),
  };
}
export interface RasterCalibration {
  attachmentId: string;
  pixelA: Point;
  pixelB: Point;
  worldA: Point;
  worldB: Point;
  opacity: number;
}
/** Survey reference transform only, not photogrammetry or perspective correction. */
export function rasterTransform(c: RasterCalibration): {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
} {
  const px = c.pixelB.x - c.pixelA.x,
    py = c.pixelB.y - c.pixelA.y,
    wx = c.worldB.x - c.worldA.x,
    wy = c.worldB.y - c.worldA.y;
  const denom = px * px + py * py;
  if (denom <= 0 || wx * wx + wy * wy <= 0)
    throw new Error('Ориентиры должны различаться');
  const a = (wx * px + wy * py) / denom,
    b = (wy * px - wx * py) / denom;
  return {
    a,
    b,
    c: -b,
    d: a,
    e: c.worldA.x - a * c.pixelA.x + b * c.pixelA.y,
    f: c.worldA.y - b * c.pixelA.x - a * c.pixelA.y,
  };
}
