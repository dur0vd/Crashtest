import type { CalculationRecord, JsonObject } from '../parallel/contracts';
import type { ReportFigure } from '../reports/model';
export interface ResidualRow {
  evidenceId: string;
  value: number;
  unit: string;
}
export function diagnostics(records: CalculationRecord[]): {
  residuals: ResidualRow[];
  figures: ReportFigure[];
} {
  const residuals: ResidualRow[] = [],
    figures: ReportFigure[] = [];
  for (const r of records) {
    if (!r.result || Array.isArray(r.result) || typeof r.result !== 'object')
      continue;
    const v = r.result as JsonObject;
    if (Array.isArray(v.residuals))
      for (const row of v.residuals) {
        if (
          row &&
          typeof row === 'object' &&
          !Array.isArray(row) &&
          typeof row.evidenceId === 'string' &&
          typeof row.value === 'number' &&
          typeof row.unit === 'string'
        )
          residuals.push({
            evidenceId: row.evidenceId,
            value: row.value,
            unit: row.unit,
          });
      }
    if (Array.isArray(v.figures))
      for (const raw of v.figures) {
        if (
          !raw ||
          typeof raw !== 'object' ||
          Array.isArray(raw) ||
          !Array.isArray(raw.points) ||
          !['line', 'histogram', 'tornado'].includes(String(raw.kind)) ||
          typeof raw.unit !== 'string' ||
          typeof raw.title !== 'string'
        )
          continue;
        const points = raw.points.filter(
          (p): p is { x: number; y: number } =>
            !!p &&
            typeof p === 'object' &&
            !Array.isArray(p) &&
            typeof p.x === 'number' &&
            Number.isFinite(p.x) &&
            typeof p.y === 'number' &&
            Number.isFinite(p.y),
        );
        if (points.length)
          figures.push({
            calculationId: r.id,
            kind: raw.kind as ReportFigure['kind'],
            unit: raw.unit,
            title: raw.title,
            ...(typeof raw.xUnit === 'string' ? { xUnit: raw.xUnit } : {}),
            ...(typeof raw.yUnit === 'string' ? { yUnit: raw.yUnit } : {}),
            points,
          });
      }
  }
  return { residuals, figures };
}
