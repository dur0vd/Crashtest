import { angDiff, type Vec } from './geom';
import type { Actor, Waypoint } from './scene';
import { dm } from './dmath';

export type VehicleSignal = 'none' | 'left' | 'right' | 'hazard';
export type SignalSource = 'explicit' | 'observed' | 'estimate' | 'none';

/** PDD 8.2 specifies timely signalling, without a number of seconds or metres.
 * These configurable training-model guides are not statutory thresholds. */
export const SIGNAL_LEAD_SECONDS = 2;
export const SIGNAL_LEAD_METERS = 10;
/** The PDD says to stop the signal immediately after the manoeuvre. This is an
 * observation tolerance of the model, not a grace period granted by the PDD. */
export const SIGNAL_CANCEL_SECONDS = 1;
/** Small changes in a drawn route are treated as a manoeuvre from this angle.
 * This drawing/observation threshold is not a requirement stated by the PDD. */
export const SIGNAL_TURN_THRESHOLD_RAD = 0.12;

export interface VehicleSignalState {
  signal: VehicleSignal;
  since: number | null;
  source: SignalSource;
}

export interface SignalSuggestion {
  waypointIndex: number;
  signal: 'left' | 'right';
  /** Absolute seconds of simulation. null means the waypoint was not observed. */
  maneuverTime: number | null;
  detail: string;
}

export interface SignalPolicy {
  leadSeconds?: number;
  leadMeters?: number;
}

export interface SuggestedSignalUpdate {
  waypointIndex: number;
  signal: 'left' | 'right';
  signalAt: number;
}

interface SignalEvent {
  waypointIndex: number;
  signal: VehicleSignal;
  time: number;
  source: Exclude<SignalSource, 'none'>;
}

// The intersection supports callers during the scene schema migration as well
// as deliberately unnormalised input; undefined is not an explicit off command.
type SignalWaypoint = Waypoint & { signal?: VehicleSignal; signalAt?: number };
const knownSignal = (signal: unknown): signal is VehicleSignal =>
  signal === 'none' || signal === 'left' || signal === 'right' || signal === 'hazard';
const validTime = (time: unknown): time is number => typeof time === 'number' && Number.isFinite(time) && time >= 0;

/** Only an editor preview: straight-line segment lengths and average endpoint
 * speed omit acceleration limits and spline curvature. Never use these times as
 * observed evidence. Supplying waypointTimes disables this fallback completely. */
function estimatedWaypointTimes(actor: Actor): (number | null)[] {
  const times: (number | null)[] = [];
  let time: number | null = validTime(actor.delay) ? actor.delay : 0;
  let point: Vec = actor;
  let speed = Number.isFinite(actor.speed) ? Math.abs(actor.speed) / 3.6 : 0;
  for (const waypoint of actor.path) {
    const distance = dm.hypot(waypoint.x - point.x, waypoint.y - point.y);
    const nextSpeed = Number.isFinite(waypoint.v) ? Math.abs(waypoint.v) / 3.6 : 0;
    const meanSpeed = (speed + nextSpeed) / 2;
    if (time !== null) {
      if (!Number.isFinite(distance) || distance > 1e-9 && meanSpeed <= 1e-9) time = null;
      else time += distance > 1e-9 ? distance / meanSpeed : 0;
    }
    times.push(time);
    if (time !== null && waypoint.v === 0 && validTime(waypoint.hold)) time += waypoint.hold;
    point = waypoint;
    speed = nextSpeed;
  }
  return times;
}

function passageTimes(actor: Actor, waypointTimes?: number[]): (number | null)[] {
  return waypointTimes === undefined ? estimatedWaypointTimes(actor)
    : actor.path.map((_, index) => validTime(waypointTimes[index]) ? waypointTimes[index] : null);
}

function signalEvents(actor: Actor, waypointTimes?: number[]): SignalEvent[] {
  const times = passageTimes(actor, waypointTimes);
  const events: SignalEvent[] = [];
  actor.path.forEach((point: SignalWaypoint, waypointIndex) => {
    if (!knownSignal(point.signal)) return;
    const explicit = validTime(point.signalAt);
    const time = explicit ? point.signalAt! : times[waypointIndex];
    if (time === null) return;
    events.push({ waypointIndex, signal: point.signal, time,
      source: explicit ? 'explicit' : waypointTimes === undefined ? 'estimate' : 'observed' });
  });
  return events.sort((a, b) => a.time - b.time
    || Number(a.source === 'explicit') - Number(b.source === 'explicit')
    || a.waypointIndex - b.waypointIndex);
}

/** Signal commands are timed events. An explicit timestamp is used even when
 * the associated waypoint has not been reached. Without a timestamp, only an
 * observed arrival may establish an event when waypointTimes was supplied.
 * A missing signal is no command; an explicit `none` switches the light off.
 * Hand signals are separate observed facts checked by the traffic-rule layer. */
export function vehicleSignalAt(actor: Actor, t: number, waypointTimes?: number[]): VehicleSignalState {
  let state: VehicleSignalState = { signal: 'none', since: null, source: 'none' };
  if (Number.isNaN(t)) return state;
  for (const event of signalEvents(actor, waypointTimes)) {
    if (event.time > t) break;
    // Repeating an already lit signal does not interrupt it or restart its lead
    // time; otherwise coordinated waypoint commands would falsely look late.
    if (event.signal !== state.signal || state.since === null) {
      state = { signal: event.signal, since: event.time, source: event.source };
    }
  }
  return state;
}

function directionForSegment(actor: Actor, segmentIndex: number): number {
  const target = actor.path[segmentIndex]?.v;
  if (target && Number.isFinite(target)) return Math.sign(target);
  for (let index = segmentIndex - 1; index >= 0; index--) {
    const previous = actor.path[index].v;
    if (previous && Number.isFinite(previous)) return Math.sign(previous);
  }
  return actor.speed < 0 ? -1 : 1;
}

/** Body heading, not just motion direction: negative speed means that a car
 * backing along the line faces the other way. A forward/reverse change with the
 * body facing the same direction must not create a fictitious U-turn hint. */
function segmentHeading(actor: Actor, segmentIndex: number): number | null {
  const start: Vec = segmentIndex === 0 ? actor : actor.path[segmentIndex - 1];
  const end: Vec = actor.path[segmentIndex];
  if (!start || !end || dm.hypot(end.x - start.x, end.y - start.y) < 1e-7) return null;
  const heading = dm.atan2(end.y - start.y, end.x - start.x);
  return heading + (directionForSegment(actor, segmentIndex) < 0 ? Math.PI : 0);
}

/** Suggestions refer to the route vertex before a change of heading. They are
 * prompts for the editor, not a determination that the manoeuvre is lawful or
 * that the signal grants priority. A shallow S bend is treated as one lane
 * change, rather than a right indicator immediately followed by a left one. */
export function suggestSignals(actor: Actor, waypointTimes?: number[]): SignalSuggestion[] {
  const times = passageTimes(actor, waypointTimes);
  const turns: { waypointIndex: number; before: number; after: number; delta: number }[] = [];
  for (let index = 0; index < actor.path.length - 1; index++) {
    let incoming = index;
    while (incoming >= 0 && segmentHeading(actor, incoming) === null) incoming--;
    let outgoing = index + 1;
    while (outgoing < actor.path.length && segmentHeading(actor, outgoing) === null) outgoing++;
    if (incoming < 0 || outgoing >= actor.path.length) continue;
    // Duplicate vertices share a turn; keep only its first waypoint command.
    if (incoming !== index) continue;
    const before = segmentHeading(actor, incoming)!;
    const after = segmentHeading(actor, outgoing)!;
    const delta = angDiff(before, after);
    if (Math.abs(delta) >= SIGNAL_TURN_THRESHOLD_RAD) turns.push({ waypointIndex: index, before, after, delta });
  }
  const suggestions: SignalSuggestion[] = [];
  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index];
    const next = turns[index + 1];
    const shallowReturn = next && next.waypointIndex === turn.waypointIndex + 1
      && Math.abs(turn.delta) < Math.PI / 4 && Math.abs(next.delta) < Math.PI / 4
      && turn.delta * next.delta < 0 && Math.abs(angDiff(turn.before, next.after)) < SIGNAL_TURN_THRESHOLD_RAD
      && directionForSegment(actor, turn.waypointIndex) === directionForSegment(actor, next.waypointIndex + 1);
    const signal = Math.abs(turn.delta) > Math.PI * 3 / 4 || turn.delta < 0 ? 'left' : 'right';
    const maneuverTime = times[turn.waypointIndex];
    const timing = waypointTimes === undefined
      ? 'Время — оценочный предпросмотр по расстояниям и скоростям; уточните его по симуляции.'
      : maneuverTime === null ? 'Точка манёвра не достигнута: время включения нужно задать вручную.'
        : 'Время основано на фактическом прохождении точки симуляции.';
    suggestions.push({ waypointIndex: turn.waypointIndex, signal, maneuverTime,
      detail: `${shallowReturn ? 'Перед смещением в соседнюю полосу' : 'Перед изменением направления'} предложен ${signal === 'left' ? 'левый' : 'правый'} сигнал. ${timing} Подача сигнала не даёт преимущества (п. 8.2). Ориентир расстояния интерполируется между контрольными точками; фактическая проверка использует время и путь симуляции.` });
    if (shallowReturn) index++;
  }
  return suggestions;
}

/** A deliberate application of a hint coordinates signal commands only in its
 * lead window. This also prevents a normalised `none` at an intermediate node
 * from cancelling the accepted suggestion. Commands outside the window remain
 * untouched; the UI must explain that commands inside this window are changed. */
function timeBeforeRouteDistance(actor: Actor, waypointIndex: number, maneuverTime: number, distance: number, times: (number | null)[]): number | null {
  if (distance === 0) return maneuverTime;
  const delay = validTime(actor.delay) ? actor.delay : 0;
  let remaining = distance;
  for (let index = waypointIndex; index >= 0; index--) {
    const start = index === 0 ? actor : actor.path[index - 1];
    const end = actor.path[index];
    const length = dm.hypot(end.x - start.x, end.y - start.y);
    if (!Number.isFinite(length)) return null;
    const startTime = index === 0 ? delay : times[index - 1];
    const endTime = index === waypointIndex ? maneuverTime : times[index];
    if (length > remaining) {
      if (startTime === null || endTime === null || endTime < startTime) return null;
      return startTime + (endTime - startTime) * (length - remaining) / length;
    }
    remaining -= length;
    if (remaining <= 1e-9) return startTime;
  }
  // The scene starts less than the guide distance before the manoeuvre. The
  // helper cannot invent an earlier observed approach, so it starts at delay.
  return delay;
}

export function suggestedSignalUpdates(actor: Actor, suggestion: SignalSuggestion, waypointTimes?: number[], policy: SignalPolicy = {}): SuggestedSignalUpdate[] {
  if (!validTime(suggestion.maneuverTime) || !actor.path[suggestion.waypointIndex]) return [];
  const delay = validTime(actor.delay) ? actor.delay : 0;
  if (suggestion.maneuverTime < delay) return [];
  const leadSeconds = validTime(policy.leadSeconds) ? policy.leadSeconds : SIGNAL_LEAD_SECONDS;
  const leadMeters = validTime(policy.leadMeters) ? policy.leadMeters : SIGNAL_LEAD_METERS;
  const distanceTime = timeBeforeRouteDistance(actor, suggestion.waypointIndex, suggestion.maneuverTime, leadMeters, passageTimes(actor, waypointTimes));
  // Both guides are approximated conservatively. Between waypoint observations
  // the route-distance timestamp is linearly interpolated for a UI suggestion;
  // the traffic-rule layer checks actual Track time and travelled distance.
  const signalAt = Math.max(delay, Math.min(suggestion.maneuverTime - leadSeconds, distanceTime ?? suggestion.maneuverTime));
  const indices = new Set([suggestion.waypointIndex]);
  for (const event of signalEvents(actor, waypointTimes)) {
    if (event.time >= signalAt && event.time <= suggestion.maneuverTime) indices.add(event.waypointIndex);
  }
  return [...indices].sort((a, b) => a - b).map(waypointIndex => ({ waypointIndex, signal: suggestion.signal, signalAt }));
}
