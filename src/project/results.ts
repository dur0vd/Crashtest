import type { CalculationRecord, PhysicsOutput } from '../parallel/contracts';
import type { ProjectFile } from './model';
import { inputHash } from './model';
import type { Report } from '../analysis/types';
export function isCalculation(c: any): c is CalculationRecord {
  return (
    !!c &&
    typeof c.id === 'string' &&
    typeof c.method === 'string' &&
    typeof c.formula === 'string' &&
    c.inputs &&
    c.units &&
    c.result !== undefined &&
    Array.isArray(c.sources) &&
    c.sources.every((s: any) => typeof s === 'string') &&
    Array.isArray(c.assumptions) &&
    c.assumptions.every((s: any) => typeof s === 'string')
  );
}
/** Restore saved data, never a calculation. Invalid/stale records are not shown as fresh. */
export async function savedData(file: ProjectFile): Promise<{
  output?: PhysicsOutput;
  calculations: CalculationRecord[];
  report?: Report;
}> {
  const hash = await inputHash(file.project),
    saved = file.savedResults as any,
    artifacts = file.artifacts as any;
  const currentSaved = file.resultInputHash === hash ? saved : undefined,
    currentArtifacts = artifacts?.inputHash === hash ? artifacts : undefined;
  const calculations = (
    currentArtifacts?.calculations ??
    currentSaved?.physics?.calculations ??
    []
  ).filter(isCalculation);
  const r = currentArtifacts?.report ?? currentSaved?.rules;
  const report =
    r &&
    r.technical &&
    Array.isArray(r.technical.events) &&
    Array.isArray(r.technical.collisions) &&
    Array.isArray(r.technical.assumptions) &&
    r.rules &&
    Array.isArray(r.rules.findings) &&
    r.legal &&
    Array.isArray(r.legal.verdicts)
      ? r
      : undefined;
  const p = currentSaved?.physics,
    t = p?.timeline;
  if (
    !t ||
    !Number.isFinite(t.dt) ||
    t.dt <= 0 ||
    !Number.isInteger(t.n) ||
    t.n < 1 ||
    t.n > 1000000 ||
    !t.tracks ||
    Array.isArray(t.tracks) ||
    !Number.isFinite(t.duration) ||
    !Array.isArray(t.collisions)
  )
    return { calculations, report };
  const tracks = new Map();
  for (const [id, raw] of Object.entries(t.tracks)) {
    const tr = raw as any;
    const arrays = ['x', 'y', 'h', 'v', 'present', 'free'];
    if (
      !arrays.every(
        (k) =>
          Array.isArray(tr[k]) &&
          tr[k].length === t.n &&
          tr[k].every(Number.isFinite),
      )
    )
      return { calculations, report };
    tracks.set(id, {
      ...tr,
      x: new Float32Array(tr.x),
      y: new Float32Array(tr.y),
      h: new Float32Array(tr.h),
      v: new Float32Array(tr.v),
      present: new Uint8Array(tr.present),
      free: new Uint8Array(tr.free),
      ...(Array.isArray(tr.reversing)
        ? { reversing: new Uint8Array(tr.reversing) }
        : {}),
    });
  }
  return { output: { ...p, timeline: { ...t, tracks } }, calculations, report };
}
