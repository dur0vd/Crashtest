import { describe, expect, it } from 'vitest';
import {
  averageSpeed, carrierSpeed, checkPts, fitHomography, fitTrajectory, imageToPlane, matmul, overlay, planeToImage, symmetricEigen,
  type Correspondence, type Matrix,
} from '../src/video-math';
import { mulberry32 } from '../src/physics';

// Independent synthetic pinhole camera: plane (x, y, 0) -> image via H = K [r1 r2 t].
function camera(): Matrix {
  const f = 1200, cx = 960, cy = 540, pitch = 0.35; // looking along +y, tilted down
  const C = [2, -25, 7];
  // camera axes in world: x_c = (1,0,0), z_c = forward-down, y_c = z_c × x_c
  const zc = [0, Math.cos(pitch), -Math.sin(pitch)], xc = [1, 0, 0];
  const yc = [zc[1] * xc[2] - zc[2] * xc[1], zc[2] * xc[0] - zc[0] * xc[2], zc[0] * xc[1] - zc[1] * xc[0]];
  const R = [xc, yc, zc];
  const t = R.map(r => -(r[0] * C[0] + r[1] * C[1] + r[2] * C[2]));
  const K = [[f, 0, cx], [0, f, cy], [0, 0, 1]];
  return matmul(K, [[R[0][0], R[0][1], t[0]], [R[1][0], R[1][1], t[1]], [R[2][0], R[2][1], t[2]]]);
}
const project = (H: Matrix, x: number, y: number) => {
  const w = H[2][0] * x + H[2][1] * y + H[2][2];
  return { u: (H[0][0] * x + H[0][1] * y + H[0][2]) / w, v: (H[1][0] * x + H[1][1] * y + H[1][2]) / w };
};
function gauss(r: () => number) { return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()); }
const marks = [[-2, 5], [6, 5], [-2, 30], [6, 30], [2, 15], [-1, 45], [5, 45], [2, 60]];

describe('homography calibration', () => {
  it('Jacobi eigen-decomposition reproduces A·v = λ·v', () => {
    const A = [[4, 1, 0.5], [1, 3, 0.2], [0.5, 0.2, 1]];
    const { values, vectors } = symmetricEigen(A);
    for (let k = 0; k < 3; k++) {
      const v = vectors.map(r => r[k]);
      const Av = A.map(r => r.reduce((s, x, i) => s + x * v[i], 0));
      Av.forEach((x, i) => expect(x).toBeCloseTo(values[k] * v[i], 10));
    }
  });
  it('exact 4-point and noisy 8-point calibrations; reprojection error and calibration sigma; collinear points rejected', () => {
    const Hc = camera();
    const exact: Correspondence[] = marks.slice(0, 4).map(([x, y]) => ({ image: project(Hc, x, y), plane: { x, y } }));
    const h4 = fitHomography(exact);
    expect(h4.rmsImage).toBeLessThan(1e-6);
    expect(h4.calibrationSigma).toBeNull();
    const p = imageToPlane(h4, project(Hc, 1, 20));
    expect(p.x).toBeCloseTo(1, 6); expect(p.y).toBeCloseTo(20, 6);
    const r = mulberry32(5);
    const noisy = marks.map(([x, y], i) => { const q = project(Hc, x, y); return { id: `m${i}`, image: { u: q.u + 0.5 * gauss(r), v: q.v + 0.5 * gauss(r) }, plane: { x, y } }; });
    const h8 = fitHomography(noisy);
    expect(h8.rmsImage).toBeGreaterThan(0.05); expect(h8.rmsImage).toBeLessThan(1.5);
    expect(h8.calibrationSigma).not.toBeNull();
    expect(h8.residuals.map(x => x.id)).toEqual(noisy.map(x => x.id));
    expect(() => fitHomography([[0, 0], [1, 1], [2, 2], [0, 5]].map(([x, y]) => ({ image: project(Hc, x, y + 5), plane: { x, y: y + 5 } })))).toThrow(/одной прямой/);
    expect(() => fitHomography(exact.slice(0, 3))).toThrow(/не менее 4/);
    const back = planeToImage(h4, { x: 3, y: 12 }), truth = project(Hc, 3, 12);
    expect(back.u).toBeCloseTo(truth.u, 4); expect(back.v).toBeCloseTo(truth.v, 4);
  });
});

describe('trajectory from wheel-contact clicks with true PTS', () => {
  const Hc = camera();
  const calib = fitHomography(marks.map(([x, y]) => ({ image: project(Hc, x, y), plane: { x, y } })));
  it('variable frame rate is detected; non-increasing timestamps rejected', () => {
    expect(checkPts([0, 0.033, 0.066, 0.1]).variableFrameRate).toBe(false);
    expect(checkPts([0, 0.02, 0.07, 0.09, 0.15]).variableFrameRate).toBe(true);
    expect(() => checkPts([0, 0.04, 0.04])).toThrow();
  });
  it('constant deceleration: speed and acceleration recovered within 3σ from noisy clicks on a variable-rate record', () => {
    const r = mulberry32(9), v0 = 12, a = -3, x = 1.5, y0 = 8, sigmaPx = 1.0;
    const pts: number[] = [];
    for (let t = 0; t < 2.5; t += (pts.length % 2 ? 0.033 : 0.042) + 0.004 * (r() - 0.5)) pts.push(t);
    const clicks = pts.map(t => { const q = project(Hc, x, y0 + v0 * t + 0.5 * a * t * t); return { pts: t, image: { u: q.u + sigmaPx * gauss(r), v: q.v + sigmaPx * gauss(r) } }; });
    const out = fitTrajectory(calib, clicks, sigmaPx, 0.35);
    expect(out.pts.variableFrameRate).toBe(true);
    const mid = out.samples.filter(s => s.t > 0.5 && s.t < 2.0);
    expect(mid.length).toBeGreaterThan(20);
    let within = 0;
    for (const s of mid) {
      const vTrue = v0 + a * s.t;
      if (Math.abs(s.speed - vTrue) <= 3 * s.speedSigma) within++;
      expect(Math.abs(s.speed - vTrue)).toBeLessThan(4.5 * s.speedSigma);
    }
    expect(within / mid.length).toBeGreaterThan(0.9);
    const accOk = mid.filter(s => Math.abs(s.acceleration - a) <= 3 * s.accelerationSigma).length;
    expect(accOk / mid.length).toBeGreaterThan(0.85);
  });
  it('average speed over a constant-speed segment', () => {
    const r = mulberry32(13), v = 9;
    const clicks = Array.from({ length: 50 }, (_, i) => { const t = i / 25; const q = project(Hc, 2, 10 + v * t); return { pts: t, image: { u: q.u + 0.8 * gauss(r), v: q.v + 0.8 * gauss(r) } }; });
    const out = averageSpeed(calib, clicks, 0.8);
    expect(Math.abs(out.speed - v)).toBeLessThan(3 * out.sigma + 1e-3);
  });
});

describe('moving camera (dashcam) and overlay', () => {
  it('carrier speed from known mark spacing with frame quantisation', () => {
    const v = 15, spacing = 12, fps = 30;
    const crossings = Array.from({ length: 8 }, (_, k) => ({ index: k, pts: Math.round((0.3 + k * spacing / v) * fps) / fps }));
    const out = carrierSpeed({ crossings, spacing, spacingSigma: 0.05, frameInterval: 1 / fps, source: 'длина штриха и разрыва по проекту разметки (тест)' });
    expect(Math.abs(out.speed - v)).toBeLessThan(3 * out.sigma);
    expect(out.segments).toHaveLength(7);
    expect(() => carrierSpeed({ crossings, spacing, spacingSigma: 0.05, source: '' })).toThrow(/источник/);
  });
  it('overlay projects simulated plane positions into the image with the sync offset', () => {
    const Hc = camera();
    const calib = fitHomography(marks.map(([x, y]) => ({ image: project(Hc, x, y), plane: { x, y } })));
    const o = overlay(calib, [{ t: 1, position: { x: 2, y: 20 } }], 0.4)[0];
    const truth = project(Hc, 2, 20);
    expect(o.pts).toBeCloseTo(1.4, 12); expect(o.u).toBeCloseTo(truth.u, 4); expect(o.v).toBeCloseTo(truth.v, 4);
  });
});
