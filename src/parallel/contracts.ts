/** Shared boundary for the three independent implementation chats.
 * Types only: this file does not implement or advertise a calculation.
 * Scene keeps its existing km/h conventions; physical calculations use SI.
 */
import type { Report } from '../analysis/types';
import type { Scene } from '../scene';
import type { Timeline } from '../sim';

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export interface EvidenceObservation {
  id: string;
  kind: string;
  geometry: JsonObject;
  values: JsonObject;
  source?: string;
  uncertainty?: JsonObject;
}

/** An outer project envelope preserves extensions without changing legacy
 * normalizeScene into a parser for three independently developed schemas.
 */
export interface ProjectEnvelope {
  contractVersion: 1;
  scene: Scene;
  extensions: {
    physics: JsonObject;
    rules: JsonObject;
    workspace: JsonObject;
  };
  evidence: EvidenceObservation[];
}

export interface FeatureIssue {
  code: string;
  message: string;
  source?: string;
  path?: string;
}

/** Unsupported or missing input can never masquerade as a successful result. */
export type FeatureResult<T> =
  | { status: 'ok'; value: T; issues: FeatureIssue[] }
  | { status: 'unsupported' | 'insufficient-data' | 'error'; issues: FeatureIssue[] };

export interface InputDescriptor {
  /** RFC 6901 JSON Pointer within ProjectEnvelope. */
  path: string;
  label: string;
  kind: 'number' | 'boolean' | 'text' | 'enum' | 'geometry';
  unit?: string;
  required?: boolean;
  choices?: { value: string; label: string }[];
  minimum?: number;
  maximum?: number;
}

export interface FeatureDescriptor {
  id: string;
  title: string;
  available: boolean;
  reason?: string;
  inputs: InputDescriptor[];
}

export interface CalculationRecord {
  id: string;
  method: string;
  inputs: JsonObject;
  formula: string;
  result: JsonValue;
  units: JsonObject;
  sources: string[];
  assumptions: string[];
}

export interface PhysicsOutput {
  timeline: Timeline;
  calculations: CalculationRecord[];
  technical: JsonObject;
  observations: EvidenceObservation[];
  /** Optional wheel/visibility/post-impact samples for rendering, not a
   * second hidden simulation performed by the UI.
   */
  renderData?: JsonObject;
}

export interface RunControl {
  onProgress?: (completed: number, total: number) => void;
  isCancelled?: () => boolean;
}

export interface PhysicsPort {
  contractVersion: 1;
  describe(project: ProjectEnvelope): FeatureDescriptor[];
  simulate(project: ProjectEnvelope, control?: RunControl): Promise<FeatureResult<PhysicsOutput>>;
  calculate(method: string, project: ProjectEnvelope, parameters: JsonObject,
    control?: RunControl): Promise<FeatureResult<CalculationRecord[]>>;
}

export interface RulesPort {
  contractVersion: 1;
  describe(project: ProjectEnvelope): FeatureDescriptor[];
  evaluate(project: ProjectEnvelope, timeline: Timeline,
    physical?: PhysicsOutput): Promise<FeatureResult<Report>>;
}

export interface WorkbenchPorts {
  physics?: PhysicsPort;
  rules?: RulesPort;
}
