import { buildGeo } from '../geo';
import { dimsOf, actorLabels } from '../scene';
import type { ProjectEnvelope } from '../parallel/contracts';
import type { Point } from './model';
export interface PlanPolygon {
  points: Point[];
  label?: string;
  kind: 'road' | 'actor';
}
/** Geometry for drawing only. Reuses the established road edges and actor sizes. */
export function planPolygons(project: ProjectEnvelope): PlanPolygon[] {
  const roads = buildGeo(project.scene).roads.map((r) => ({
    kind: 'road' as const,
    points: [...r.left, ...[...r.right].reverse()],
  }));
  const labels = actorLabels(project.scene);
  const actors = project.scene.actors.map((a) => {
    const d = dimsOf(a),
      c = Math.cos(a.heading),
      s = Math.sin(a.heading);
    return {
      kind: 'actor' as const,
      label: labels.get(a.id),
      points: [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].map(([u, v]) => ({
        x: a.x + (c * u * d.length) / 2 - (s * v * d.width) / 2,
        y: a.y + (s * u * d.length) / 2 + (c * v * d.width) / 2,
      })),
    };
  });
  return [...roads, ...actors];
}
export function landmarks(
  project: ProjectEnvelope,
): { point: Point; label: string }[] {
  const raw = project.extensions.workspace.landmarks;
  if (!raw || Array.isArray(raw) || typeof raw !== 'object') return [];
  return ['A', 'B'].flatMap((key) => {
    const p = raw[key];
    return p &&
      typeof p === 'object' &&
      !Array.isArray(p) &&
      typeof p.x === 'number' &&
      typeof p.y === 'number'
      ? [
          {
            point: { x: p.x, y: p.y },
            label: `${key}: ${typeof p.label === 'string' ? p.label : ''}`,
          },
        ]
      : [];
  });
}
