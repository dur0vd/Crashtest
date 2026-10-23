import { encode } from 'fast-png';
import type { ReportFigure } from './model';
export function chartSegments(
  f: ReportFigure,
  width = 700,
  height = 220,
): { x1: number; y1: number; x2: number; y2: number; bar: boolean }[] {
  if (!f.points.length) return [];
  const xs = f.points.map((p) => p.x),
    ys = f.points.map((p) => p.y),
    xmin = Math.min(0, ...xs),
    xmax = Math.max(...xs),
    ymin = Math.min(0, ...ys),
    ymax = Math.max(...ys);
  const x = (n: number) =>
      45 + ((n - xmin) / (xmax - xmin || 1)) * (width - 80),
    y = (n: number) =>
      height - 35 - ((n - ymin) / (ymax - ymin || 1)) * (height - 65);
  return f.points.map((p, i) =>
    f.kind === 'line'
      ? {
          x1: x(f.points[Math.max(0, i - 1)].x),
          y1: y(f.points[Math.max(0, i - 1)].y),
          x2: x(p.x),
          y2: y(p.y),
          bar: false,
        }
      : f.kind === 'tornado'
        ? { x1: x(0), y1: y(p.y), x2: x(p.x), y2: y(p.y), bar: true }
        : { x1: x(p.x), y1: y(0), x2: x(p.x), y2: y(p.y), bar: true },
  );
}
/** Raster rendering only, numeric values are supplied by the calculation port. */
export function chartPNG(
  f: ReportFigure,
  width = 700,
  height = 220,
): Uint8Array {
  const pixels = new Uint8Array(width * height * 3).fill(255);
  const dot = (x: number, y: number) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x >= 0 && x < width && y >= 0 && y < height) {
      const i = (y * width + x) * 3;
      pixels[i] = 21;
      pixels[i + 1] = 91;
      pixels[i + 2] = 143;
    }
  };
  for (const s of chartSegments(f, width, height)) {
    const n = Math.max(Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1), 1);
    for (let i = 0; i <= n; i++) {
      const x = s.x1 + ((s.x2 - s.x1) * i) / n,
        y = s.y1 + ((s.y2 - s.y1) * i) / n;
      for (let a = -2; a <= 2; a++)
        dot(
          x + (f.kind === 'tornado' ? 0 : a),
          y + (f.kind === 'tornado' ? a : 0),
        );
    }
  }
  return encode({ width, height, data: pixels, channels: 3, depth: 8 });
}
