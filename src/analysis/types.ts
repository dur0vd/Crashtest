import type { Collision } from '../sim';
import type { LawRef } from '../law';

export type Severity = 'violation' | 'contributing' | 'info';

export interface Finding {
  actorId: string;
  severity: Severity;
  title: string;
  detail: string;
  refs: string[];
  t?: number;
  /** нарушение находится в причинной связи со столкновением */
  causal: boolean;
  trace: Trace;
  requirement: string;
  compliance: Compliance;
  prevention: boolean | null;
}

export type HarmLevel = 'none' | 'light' | 'medium' | 'severe' | 'fatal';

export const HARM_LABEL: Record<HarmLevel, string> = {
  none: 'вред здоровью маловероятен',
  light: 'возможен лёгкий вред здоровью',
  medium: 'возможен вред здоровью средней тяжести',
  severe: 'возможен тяжкий вред здоровью',
  fatal: 'высокий риск гибели',
};

export const HARM_ORDER: HarmLevel[] = ['none', 'light', 'medium', 'severe', 'fatal'];
export const harmRank = (h: HarmLevel): number => HARM_ORDER.indexOf(h);

export interface TechAssessment {
  trace: Trace;
  ranges: { reaction: [number, number]; stopDist: [number, number] };
  actorId: string;
  otherId: string;
  /** момент возникновения опасности, с */
  tHazard: number;
  speedKmh: number;
  /** расстояние до места столкновения в момент опасности, м */
  available: number;
  /** остановочный путь, м */
  stopDist: number;
  avoidable: boolean;
  /** наибольшая скорость, при которой столкновение удавалось предотвратить, км/ч */
  safeKmh: number;
  limitKmh?: number;
  avoidableAtLimit?: boolean;
}

export interface CollisionReport {
  trace: Trace;
  collision: Collision;
  title: string;
  description: string;
  harm: { actorId: string; level: HarmLevel; trace: Trace }[];
  tech: TechAssessment[];
  notes: string[];
}

export interface LegalItem {
  refs: string[];
  text: string;
  trace: Trace;
  sanctions?: { ref: string; text: string | null; editionDate: string; available: boolean }[];
}

export interface ActorVerdict {
  actorId: string;
  status: 'causal-violation' | 'no-violations' | 'noncausal-violation' | 'insufficient-data';
  text: string;
  legal: LegalItem[];
  trace: Trace;
}

export type Trace = { [key: string]: unknown };
export type Compliance = 'выполнено' | 'не выполнено' | 'не определить';
export type FindingInput = Omit<Finding, 'causal' | 'trace' | 'requirement' | 'compliance' | 'prevention'> & { causal?: boolean; trace?: Trace };
export type DraftFinding = Omit<FindingInput, 'causal'> & { causal: boolean };
export type LegalInput = Pick<LegalItem, 'refs' | 'text'>;
export const STATUS_LABEL: Record<ActorVerdict['status'], string> = {
  'causal-violation': 'нарушение в причинной связи',
  'noncausal-violation': 'нарушение без причинной связи',
  'no-violations': 'нарушений не выявлено',
  'insufficient-data': 'недостаточно данных',
};

export interface Report {
  accidentDate: string;
  laws: LawRef[];
  legalWarnings: string[];
  technical: TechnicalSection;
  rules: RulesSection;
  legal: LegalSection;
  hasCollision: boolean;
  summary: string[];
  events: { t: number; text: string }[];
  /** Compatibility view, including references added by the legal stage. Prefer rules.findings. */
  findings: Finding[];
  collisions: CollisionReport[];
  verdicts: ActorVerdict[];
  duties: LegalItem[];
  assumptions: string[];
}


export interface TechnicalEvent {
  actorId: string;
  t: number;
  kind: 'stop-line' | 'sign' | 'collision';
  text: string;
  trace: Trace;
}
export interface TechnicalCollision {
  collision: Collision;
  harm: CollisionReport['harm'];
  tech: TechAssessment[];
  trace: Trace;
}
export interface TechnicalSection {
  nearMisses: { a: string; b: string; frame: number; t: number; gap: number; trace: Trace }[];
  overtakes: { overtaker: string; overtaken: string; frame: number; trace: Trace }[];
  points: TechnicalPoint[];
  events: TechnicalEvent[];
  collisions: TechnicalCollision[];
  assumptions: string[];
}
export interface RulesSection {
  actors: Omit<ActorVerdict, 'legal'>[];
  findings: Finding[];
  collisions: CollisionReport[];
}
export interface LegalSection {
  assessmentDate: string;
  editionDate: string;
  verdicts: ActorVerdict[];
  duties: LegalItem[];
}

export interface TechnicalPoint {
  actorId: string;
  frame: number;
  t: number;
  x: number;
  y: number;
  speedKmh: number;
  roads: { roadId: string; lateral: number; laneFromAxis: number; forward: boolean }[];
  trace: Trace;
}
