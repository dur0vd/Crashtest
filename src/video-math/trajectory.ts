import { type Homography, type ImagePoint, type PlanePoint, planeWithCovariance } from './homography';
import { type Matrix, inverse } from './linalg';
import { dm } from '../dmath';

/** One annotated frame: true presentation timestamp (s) and the wheel–road contact pixel. */
export interface TrackClick { pts: number; image: ImagePoint }

export interface PtsDiagnostics {
  frames: number;
  meanInterval: number;
  minInterval: number;
  maxInterval: number;
  /** Coefficient of variation of intervals; > 0.05 flags variable frame rate. */
  intervalCv: number;
  variableFrameRate: boolean;
  warnings: string[];
}

/** Uses the true PTS; never a nominal FPS. Non-increasing timestamps are an error. */
export function checkPts(pts: number[]): PtsDiagnostics {
  if (pts.length < 2) throw new Error('Видео: нужно не менее двух кадров');
  const d: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    if (!Number.isFinite(pts[i]) || !(pts[i] > pts[i - 1])) throw new Error(`Видео: метки времени должны строго возрастать (кадр ${i})`);
    d.push(pts[i] - pts[i - 1]);
  }
  const mean = d.reduce((s, x) => s + x, 0) / d.length;
  const cv = Math.sqrt(d.reduce((s, x) => s + (x - mean) ** 2, 0) / d.length) / mean;
  const variable = cv > 0.05;
  return { frames: pts.length, meanInterval: mean, minInterval: Math.min(...d), maxInterval: Math.max(...d), intervalCv: cv, variableFrameRate: variable,
    warnings: variable ? [`Неравномерные метки времени (CV интервалов ${(cv * 100).toFixed(1)} %): используются истинные PTS, номинальная частота кадров неприменима.`] : [] };
}

export interface TrajectorySample {
  t: number;
  position: PlanePoint;
  positionCov: Matrix;
  velocity: PlanePoint;
  speed: number;
  speedSigma: number;
  acceleration: number;
  accelerationSigma: number;
  windowPoints: number;
}

/**
 * Weighted local quadratic fit p(t) = a + b(t−t0) + c(t−t0)² per axis over a
 * window of the given half-width (s) using true PTS. Weights 1/σ² from the
 * propagated click/calibration covariance (diagonal terms; the x–y correlation
 * is ignored in the fit — stated limitation). Parameter covariance (XᵀWX)⁻¹
 * gives σ of velocity (b) and acceleration (2c); speed σ by the gradient of |v|.
 */
export function fitTrajectory(h: Homography, clicks: TrackClick[], pixelSigma: number, halfWindow: number): { samples: TrajectorySample[]; pts: PtsDiagnostics; method: string; assumptions: string[] } {
  if (!(pixelSigma > 0)) throw new Error('Видео: погрешность клика σ > 0');
  if (!(halfWindow > 0)) throw new Error('Видео: полуширина окна сглаживания > 0');
  const pts = checkPts(clicks.map(c => c.pts));
  const obs = clicks.map(c => ({ t: c.pts, ...planeWithCovariance(h, c.image, pixelSigma) }));
  const samples: TrajectorySample[] = [];
  for (const centre of obs) {
    const win = obs.filter(o => Math.abs(o.t - centre.t) <= halfWindow + 1e-12);
    if (win.length < 3) continue;
    const fit = (axis: 0 | 1) => {
      const XtWX = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], XtWy = [0, 0, 0];
      for (const o of win) {
        const dt = o.t - centre.t, row = [1, dt, dt * dt], w = 1 / o.cov[axis][axis], y = axis === 0 ? o.point.x : o.point.y;
        for (let i = 0; i < 3; i++) { XtWy[i] += w * row[i] * y; for (let j = 0; j < 3; j++) XtWX[i][j] += w * row[i] * row[j]; }
      }
      const cov = inverse(XtWX);
      const beta = cov.map(r => r.reduce((s, v, k) => s + v * XtWy[k], 0));
      return { beta, cov };
    };
    const fx = fit(0), fy = fit(1);
    const vx = fx.beta[1], vy = fy.beta[1], speed = dm.hypot(vx, vy);
    const ux = speed > 0 ? vx / speed : 1, uy = speed > 0 ? vy / speed : 0;
    const ax = 2 * fx.beta[2], ay = 2 * fy.beta[2];
    // Tangential acceleration and its σ (projection on the velocity direction).
    const at = ax * ux + ay * uy;
    samples.push({
      t: centre.t, position: { x: fx.beta[0], y: fy.beta[0] }, positionCov: [[fx.cov[0][0], 0], [0, fy.cov[0][0]]],
      velocity: { x: vx, y: vy }, speed, speedSigma: Math.sqrt(ux * ux * fx.cov[1][1] + uy * uy * fy.cov[1][1]),
      acceleration: at, accelerationSigma: 2 * Math.sqrt(ux * ux * fx.cov[2][2] + uy * uy * fy.cov[2][2]), windowPoints: win.length,
    });
  }
  return { samples, pts, method: 'weighted local quadratic regression on true PTS',
    assumptions: ['Точка — контакт колеса с дорогой (лежит в плоскости дороги); иначе гомография даёт смещённое положение.',
      `Окно сглаживания ±${halfWindow} с, квадратичная модель движения внутри окна; на краях записи окно неполное.`,
      'Погрешность — распространение σ клика и калибровки; корреляция x–y в подгонке не учитывается; это не учёт ошибок разметки неверной точки.'] };
}

/**
 * Average speed over the whole annotated segment by a weighted straight-line fit
 * of the travelled distance s(t) (constant speed) — common reconstruction output.
 */
export function averageSpeed(h: Homography, clicks: TrackClick[], pixelSigma: number): { speed: number; sigma: number; distance: number; duration: number } {
  checkPts(clicks.map(c => c.pts));
  const obs = clicks.map(c => ({ t: c.pts, ...planeWithCovariance(h, c.image, pixelSigma) }));
  const first = obs[0].point, last = obs[obs.length - 1].point;
  const len = dm.hypot(last.x - first.x, last.y - first.y);
  const u = len > 0 ? { x: (last.x - first.x) / len, y: (last.y - first.y) / len } : { x: 1, y: 0 };
  let Sw = 0, St = 0, Ss = 0, Stt = 0, Sts = 0;
  for (const o of obs) {
    const s = (o.point.x - first.x) * u.x + (o.point.y - first.y) * u.y;
    const varS = u.x * u.x * o.cov[0][0] + 2 * u.x * u.y * o.cov[0][1] + u.y * u.y * o.cov[1][1], w = 1 / varS;
    Sw += w; St += w * o.t; Ss += w * s; Stt += w * o.t * o.t; Sts += w * o.t * s;
  }
  const D = Sw * Stt - St * St;
  return { speed: (Sw * Sts - St * Ss) / D, sigma: Math.sqrt(Sw / D), distance: len, duration: obs[obs.length - 1].t - obs[0].t };
}
