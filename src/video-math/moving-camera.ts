import { checkPts } from './trajectory';
import type { Homography, PlanePoint } from './homography';
import { planeToImage } from './homography';

/**
 * Camera carried by a moving vehicle (dashcam). The carrier speed follows from
 * the instants (true PTS) at which marks with a known spacing along the road
 * (e.g. dashes of marking 1.5 of documented length/gap, poles) cross a fixed
 * reference line in the image. Distance s_k = k·spacing; a weighted straight-line
 * fit s(t) gives the mean speed. Timing uncertainty: each crossing is known to
 * ±1/2 frame interval (uniform quantisation, σ = interval/√12) plus the spacing σ.
 */
export interface MarkCrossing { pts: number; index: number }

export function carrierSpeed(input: { crossings: MarkCrossing[]; spacing: number; spacingSigma: number; frameInterval?: number; source: string }): {
  speed: number; sigma: number; segments: { from: number; to: number; speed: number }[]; frameInterval: number; warnings: string[]; assumptions: string[];
} {
  if (input.crossings.length < 2) throw new Error('Регистратор: нужно не менее двух пересечений отметок');
  if (!(input.spacing > 0) || !(input.spacingSigma >= 0)) throw new Error('Регистратор: шаг отметок > 0 и σ ≥ 0');
  if (!input.source?.trim()) throw new Error('Регистратор: нужен источник шага отметок');
  const c = [...input.crossings].sort((a, b) => a.pts - b.pts);
  const diag = checkPts(c.map(x => x.pts));
  const interval = input.frameInterval ?? diag.minInterval;
  const sigmaT = interval / Math.sqrt(12);
  // Errors in time are converted to distance with a first speed estimate (iterate once).
  const fit = (vGuess: number) => {
    let Sw = 0, St = 0, Ss = 0, Stt = 0, Sts = 0;
    for (const x of c) {
      const s = (x.index - c[0].index) * input.spacing;
      const varS = (vGuess * sigmaT) ** 2 + ((x.index - c[0].index) * input.spacingSigma) ** 2 + 1e-12;
      const w = 1 / varS;
      Sw += w; St += w * x.pts; Ss += w * s; Stt += w * x.pts * x.pts; Sts += w * x.pts * s;
    }
    const D = Sw * Stt - St * St;
    return { speed: (Sw * Sts - St * Ss) / D, sigma: Math.sqrt(Sw / D) };
  };
  const first = ((c[c.length - 1].index - c[0].index) * input.spacing) / (c[c.length - 1].pts - c[0].pts);
  const r = fit(first);
  return {
    speed: r.speed, sigma: r.sigma, frameInterval: interval, warnings: diag.warnings,
    segments: c.slice(1).map((x, i) => ({ from: c[i].pts, to: x.pts, speed: (x.index - c[i].index) * input.spacing / (x.pts - c[i].pts) })),
    assumptions: ['Камера жёстко закреплена в ТС; опорная линия на изображении неподвижна; отметки лежат вдоль траектории ТС.',
      `Момент пересечения известен с точностью до кадра (σ = Δt/√12 = ${sigmaT.toFixed(4)} с); шаг отметок ${input.spacing} ± ${input.spacingSigma} м (${input.source}).`,
      'Перспектива не влияет, так как используется одна и та же линия изображения; поворот ТС между отметками не учитывается.'],
  };
}

/** Overlay data: simulated plane positions projected into the static-camera image (no drawing). */
export function overlay(h: Homography, positions: { t: number; position: PlanePoint }[], videoOffset: number): { pts: number; u: number; v: number }[] {
  return positions.map(p => ({ pts: p.t + videoOffset, ...planeToImage(h, p.position) }));
}
