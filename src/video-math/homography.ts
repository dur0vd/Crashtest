import { type Matrix, det3, inverse, matmul, symmetricEigen, transpose } from './linalg';
import { dm } from '../dmath';

export interface ImagePoint { u: number; v: number }
export interface PlanePoint { x: number; y: number }

export interface Correspondence { id?: string; image: ImagePoint; plane: PlanePoint }

export interface Homography {
  /** Image (px) → road plane (m), normalised so that H[2][2] = 1 when possible. */
  H: Matrix;
  Hinv: Matrix;
  points: number;
  /** Per-point reprojection: plane-space error (m) and image-space error (px). */
  residuals: { id?: string; planeError: number; imageError: number }[];
  rmsPlane: number;
  rmsImage: number;
  /** Calibration σ in the plane from redundancy (2n−8 dof); null for exactly 4 points. */
  calibrationSigma: number | null;
  method: string;
  assumptions: string[];
}

function normaliser(pts: { a: number; b: number }[]): Matrix {
  const ca = pts.reduce((s, p) => s + p.a, 0) / pts.length, cb = pts.reduce((s, p) => s + p.b, 0) / pts.length;
  const d = pts.reduce((s, p) => s + dm.hypot(p.a - ca, p.b - cb), 0) / pts.length;
  const k = d > 0 ? Math.SQRT2 / d : 1;
  return [[k, 0, -k * ca], [0, k, -k * cb], [0, 0, 1]];
}

const apply = (H: Matrix, a: number, b: number): [number, number] => {
  const w = H[2][0] * a + H[2][1] * b + H[2][2];
  return [(H[0][0] * a + H[0][1] * b + H[0][2]) / w, (H[1][0] * a + H[1][1] * b + H[1][2]) / w];
};

export function imageToPlane(h: Pick<Homography, 'H'>, p: ImagePoint): PlanePoint {
  const [x, y] = apply(h.H, p.u, p.v);
  return { x, y };
}

export function planeToImage(h: Pick<Homography, 'Hinv'>, p: PlanePoint): ImagePoint {
  const [u, v] = apply(h.Hinv, p.x, p.y);
  return { u, v };
}

function collinear(a: { a: number; b: number }, b: { a: number; b: number }, c: { a: number; b: number }, scale: number): boolean {
  return Math.abs((b.a - a.a) * (c.b - a.b) - (b.b - a.b) * (c.a - a.a)) < 1e-6 * scale * scale;
}

/**
 * Normalised DLT (Hartley & Zisserman, Multiple View Geometry, 2nd ed., alg. 4.2):
 * points are normalised to centroid 0 and mean distance √2, h is the eigenvector
 * of AᵀA with the smallest eigenvalue, then denormalised. Requires ≥4 points
 * with no three collinear (in either image or plane).
 */
export function fitHomography(pairs: Correspondence[]): Homography {
  if (pairs.length < 4) throw new Error('Гомография: нужно не менее 4 соответствий');
  for (const p of pairs) if (![p.image.u, p.image.v, p.plane.x, p.plane.y].every(Number.isFinite)) throw new Error('Гомография: неверные координаты');
  const img = pairs.map(p => ({ a: p.image.u, b: p.image.v })), pl = pairs.map(p => ({ a: p.plane.x, b: p.plane.y }));
  for (const [pts, name] of [[img, 'изображении'], [pl, 'плане']] as const) {
    const scale = Math.max(...pts.map(p => dm.hypot(p.a, p.b)), 1);
    if (pairs.length === 4) for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) for (let k = j + 1; k < 4; k++) {
      if (collinear(pts[i], pts[j], pts[k], scale)) throw new Error(`Гомография: три точки на одной прямой в ${name}`);
    }
  }
  const Ti = normaliser(img), Tp = normaliser(pl);
  const A: number[][] = [];
  pairs.forEach(p => {
    const [u, v] = apply(Ti, p.image.u, p.image.v), [x, y] = apply(Tp, p.plane.x, p.plane.y);
    A.push([-u, -v, -1, 0, 0, 0, x * u, x * v, x]);
    A.push([0, 0, 0, -u, -v, -1, y * u, y * v, y]);
  });
  const AtA = matmul(transpose(A), A);
  const { vectors, values } = symmetricEigen(AtA);
  const h = vectors.map(r => r[0]);
  if (values.length > 1 && values[1] < 1e-12 * Math.max(1, values[8])) throw new Error('Гомография: решение неоднозначно (вырожденная конфигурация точек)');
  const Hn: Matrix = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], h[8]]];
  let H = matmul(matmul(inverse(Tp), Hn), Ti);
  if (Math.abs(H[2][2]) > 1e-12) H = H.map(r => r.map(x => x / H[2][2]));
  if (Math.abs(det3(H)) < 1e-15) throw new Error('Гомография: вырожденная матрица');
  const Hinv = inverse(H);
  const residuals = pairs.map(p => {
    const [x, y] = apply(H, p.image.u, p.image.v), [u, v] = apply(Hinv, p.plane.x, p.plane.y);
    return { ...(p.id ? { id: p.id } : {}), planeError: dm.hypot(x - p.plane.x, y - p.plane.y), imageError: dm.hypot(u - p.image.u, v - p.image.v) };
  });
  const rms = (xs: number[]) => Math.sqrt(xs.reduce((s, e) => s + e * e, 0) / xs.length);
  const dof = 2 * pairs.length - 8;
  return {
    H, Hinv, points: pairs.length, residuals, rmsPlane: rms(residuals.map(r => r.planeError)), rmsImage: rms(residuals.map(r => r.imageError)),
    calibrationSigma: dof > 0 ? Math.sqrt(residuals.reduce((s, r) => s + r.planeError ** 2, 0) / dof) : null,
    method: 'normalized DLT (Hartley–Zisserman alg. 4.2), eigenvector of AᵀA',
    assumptions: [
      'Неподвижная камера, дорога — плоскость; дисторсия объектива не моделируется (исправлять до калибровки).',
      'Точки калибровки — неподвижные объекты сцены с известными координатами плана (разметка, углы, опоры).',
      ...(dof > 0 ? [] : ['Ровно 4 точки: модель проходит через них точно, погрешность калибровки по избыточности не оценивается.']),
    ],
  };
}

/** Jacobian d(x,y)/d(u,v) of the image→plane map at a pixel. */
export function planeJacobian(H: Matrix, p: ImagePoint): Matrix {
  const w = H[2][0] * p.u + H[2][1] * p.v + H[2][2];
  const x = (H[0][0] * p.u + H[0][1] * p.v + H[0][2]) / w, y = (H[1][0] * p.u + H[1][1] * p.v + H[1][2]) / w;
  return [[(H[0][0] - x * H[2][0]) / w, (H[0][1] - x * H[2][1]) / w], [(H[1][0] - y * H[2][0]) / w, (H[1][1] - y * H[2][1]) / w]];
}

/**
 * Plane position with covariance: click σ (px, isotropic) through the Jacobian
 * plus the calibration σ (isotropic, m) when it could be estimated.
 */
export function planeWithCovariance(h: Homography, p: ImagePoint, pixelSigma: number): { point: PlanePoint; cov: Matrix } {
  const J = planeJacobian(h.H, p), s2 = pixelSigma * pixelSigma, c2 = (h.calibrationSigma ?? 0) ** 2;
  const cov = [
    [s2 * (J[0][0] ** 2 + J[0][1] ** 2) + c2, s2 * (J[0][0] * J[1][0] + J[0][1] * J[1][1])],
    [s2 * (J[0][0] * J[1][0] + J[0][1] * J[1][1]), s2 * (J[1][0] ** 2 + J[1][1] ** 2) + c2],
  ];
  return { point: imageToPlane(h, p), cov };
}
