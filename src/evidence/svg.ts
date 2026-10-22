import { planPolygons, landmarks } from './plan-data';
import type { ProjectEnvelope } from '../parallel/contracts';
import { EVIDENCE_KINDS, pointsOf } from './model';
export const escapeXML = (s: string): string =>
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(
    /[<>&"']/g,
    (c) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        '"': '&quot;',
        "'": '&apos;',
      })[c]!,
  );
export interface SchemeOptions {
  scale: number;
  originX: number;
  originY: number;
  widthMm?: number;
  heightMm?: number;
}
/** Physical mm dimensions and denominator, independent of screen/print DPI.
 * Export at 100% (no fit-to-page). Coordinates use scene x-right/y-down convention.
 */
export function schemeSVG(p: ProjectEnvelope, o: SchemeOptions): string {
  if (
    !Number.isFinite(o.scale) ||
    o.scale <= 0 ||
    ![o.originX, o.originY].every(Number.isFinite)
  )
    throw new Error('Масштаб/начало');
  const legendLines = p.evidence.flatMap((e, i) => {
    const text = `${i + 1}. ${EVIDENCE_KINDS[e.kind as keyof typeof EVIDENCE_KINDS] ?? e.kind}; ${e.source ?? 'источник неизвестен'}; ±${e.uncertainty?.metres ?? '?'} м`;
    return text.match(/.{1,120}/gu) ?? [''];
  });
  const w = o.widthMm ?? 420,
    baseH = o.heightMm ?? 297,
    h = baseH + Math.max(0, legendLines.length - 7) * 4,
    k = 1000 / o.scale;
  const x = (v: number) => 15 + (v - o.originX) * k,
    y = (v: number) => 25 + (v - o.originY) * k;
  const line = (
    points: { x: number; y: number }[],
    color: string,
    width = 0.5,
  ) =>
    `<polyline points="${points.map((p) => `${x(p.x)},${y(p.y)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="${width}"/>`;
  const polygons = planPolygons(p);
  const shape = (points: { x: number; y: number }[], fill: string) =>
    `<polygon points="${points.map((v) => `${x(v.x)},${y(v.y)}`).join(' ')}" fill="${fill}" stroke="#334f68" stroke-width="0.3"/>`;
  const roads = polygons
    .filter((v) => v.kind === 'road')
    .map((v) => shape(v.points, '#d8dde1'))
    .join('');
  const observations = p.evidence
    .map((e, i) => {
      const pts = pointsOf(e),
        start = pts[0];
      if (!start) return '';
      const dimensions = pts
        .slice(1)
        .map((b, j) => {
          const a = pts[j];
          return `<text x="${x((a.x + b.x) / 2)}" y="${y((a.y + b.y) / 2) - 1}" font-size="2.8">${Math.hypot(b.x - a.x, b.y - a.y).toFixed(3)} м</text>`;
        })
        .join('');
      return (
        line(pts, '#a42317') +
        `<circle cx="${x(start.x)}" cy="${y(start.y)}" r="1" fill="#a42317"/><text x="${x(start.x) + 2}" y="${y(start.y) - 2}" font-size="3.5">${i + 1}</text>` +
        dimensions
      );
    })
    .join('');
  const actors = polygons
    .filter((v) => v.kind === 'actor')
    .map(
      (v) =>
        shape(v.points, 'none') +
        `<text x="${x(v.points[0].x)}" y="${y(v.points[0].y) - 2}" font-size="3">${escapeXML(v.label ?? 'Участник')}</text>`,
    )
    .join('');
  const refs = landmarks(p)
    .map(
      (v) =>
        `<circle cx="${x(v.point.x)}" cy="${y(v.point.y)}" r="1.5" fill="#155b8f"/><text x="${x(v.point.x) + 2}" y="${y(v.point.y)}" font-size="3">${escapeXML(v.label)}</text>`,
    )
    .join('');
  const cropped = polygons
    .flatMap((v) => v.points)
    .some(
      (v) =>
        x(v.x) < 10 || x(v.x) > w - 10 || y(v.y) < 20 || y(v.y) > baseH - 65,
    );
  const legend = legendLines
    .map(
      (text, i) =>
        `<text x="15" y="${baseH - 52 + i * 4}" font-size="3">${escapeXML(text)}</text>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}"><title>Схема ДТП — 1:${o.scale}</title><defs><clipPath id="plan"><rect x="10" y="20" width="${w - 20}" height="${baseH - 85}"/></clipPath></defs><rect width="${w}" height="${h}" fill="white"/><g font-family="DejaVu Sans, sans-serif" fill="#111"><text x="15" y="12" font-size="5">Схема ДТП. Масштаб 1:${o.scale}. Печать 100%.</text><text x="15" y="17" font-size="2.6">${cropped ? 'Часть геометрии вне рамки: измените начало/масштаб. ' : ''}Размеры ТС — данные сцены, не независимый обмер.</text><g clip-path="url(#plan)">${roads}${actors}${observations}${refs}</g>${legend}<path d="M15 ${h - 18}h${k}" stroke="black" stroke-width="0.6"/><text x="15" y="${h - 20}" font-size="3">1 м</text><text x="80" y="${h - 12}" font-size="3">Участник __________________    Участник __________________    Составил __________________</text></g></svg>`;
}
