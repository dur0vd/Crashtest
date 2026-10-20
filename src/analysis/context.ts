import type { Actor, CenterMarking, Sign, TrafficLight } from '../scene';
import type { Track } from '../sim';
import type { DraftFinding } from './types';
import type { TechnicalContext } from './technical';
import type { PriorityGraph } from './intersections';

export interface Info {
  a: Actor;
  title: string;
  label: string;
  tr: Track;
  isVeh: boolean;
  hl: number;
  hw: number;
  /** смещение центра кузова с грузом вдоль курса */
  shift: number;
  /** полудлина и полуширина самого ТС без груза */
  hlBase: number;
  hwBase: number;
  mass: number;
  k0: number;
  kEnd: number;
  trav: Float32Array;
  brake: number;
  rail: boolean;
}

export interface GateEvent {
  actorId: string;
  frame: number;
  dist: number;
  sign?: Sign;
  light?: TrafficLight;
  /** кадр, с которого знак перестаёт действовать (заполняется computeGateEnds) */
  until?: number;
}

export interface Ctx extends TechnicalContext {
  findings: DraftFinding[];
  priorityGraphs: PriorityGraph[];
  events: { t: number; text: string }[];
  /** кадры, на которых участник частично находился на встречной стороне */
  onc: Map<string, { frames: number[]; center: CenterMarking; lanes: number; tramTrack: boolean }>;
  lightViolations: Map<string, { light: TrafficLight; frame: number }[]>;
  stopSkipped: Map<string, number[]>;
  pedEntry: Map<string, { frame: number; onCrosswalk: boolean; pedGreen: boolean | null; crosswalkId?: string }>;
}
