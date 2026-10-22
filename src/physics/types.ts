/** All quantities are SI: m, kg, s, rad, N, N m. No km/h inside the kernel. */
export interface ParameterSource {
  kind: 'measured' | 'reference' | 'synthetic';
  description: string;
  url?: string;
  documentPage?: string;
  retrievedAt?: string;
}

export interface VehicleBody {
  mass: number;
  yawInertia: number;
  length: number;
  width: number;
  lf: number;
  lr: number;
  trackFront: number;
  trackRear: number;
  cgHeight: number;
  /** OBB centre relative to CG along body x, metres; not inferred from lf/lr. */
  bodyCenterOffset: number;
  source: ParameterSource;
  bodyCenterSource: ParameterSource;
}

export interface DugoffTyres {
  model: 'dugoff';
  /** Per tyre: longitudinal stiffness N / unit slip; cornering stiffness N/rad. */
  longitudinalStiffness: number;
  corneringStiffnessFront: number;
  corneringStiffnessRear: number;
  /** Multipliers on supplied road mu; 1/1 is the friction circle. */
  frictionScaleX: number;
  frictionScaleY: number;
  source: ParameterSource;
}

export interface DynamicVehicleParameters {
  schemaVersion: 1;
  id: string;
  /** Explicit applicability; no fallback by mass or vehicle name. */
  vehicleTypes: ('car' | 'suv' | 'van' | 'truck' | 'bus' | 'trolleybus')[];
  body: VehicleBody;
  tyres: DugoffTyres;
  brakes: {
    /** Total wheel-plane demand at brake=1, N, before tyre saturation. */
    maxForce: number;
    frontFraction: number;
    /** unknown is not disabled; braking with unknown ABS is rejected. */
    abs: 'unknown' | 'disabled' | 'ideal';
    source: ParameterSource;
  };
  drive: {
    axle: 'front' | 'rear' | 'all';
    /** Total wheel-plane demand at |drive|=1, N. No engine/gearbox model. */
    maxForce: number;
    source: ParameterSource;
  };
  loadTransfer: {
    /** Share of roll moment carried by front axle, explicit suspension reduction. */
    frontRollFraction: number;
    source: ParameterSource;
  };
}

/** Coordinates match geom.ts: body x forward, y right, positive yaw clockwise. */
export interface DynamicState {
  x: number;
  y: number;
  heading: number;
  /** World-frame velocity m/s; remains inertial when body rotates without forces. */
  vx: number;
  vy: number;
  yawRate: number;
  /** Previous substep inertial acceleration in body frame for quasi-static loads. */
  ax: number;
  ay: number;
}

export interface DynamicControl {
  /** Same steer at both front wheels; radians, positive right. */
  steering: number;
  /** Signed force demand [-1, 1]. Negative commands reverse drive. */
  drive: number;
  brake: number;
}

export interface DynamicRoad {
  mu: number;
  source: ParameterSource;
}

export type WheelId = 'front-left' | 'front-right' | 'rear-left' | 'rear-right';
export interface WheelForce {
  id: WheelId;
  x: number;
  y: number;
  normalLoad: number;
  /** Wheel-frame velocities and forces; applied forces before numerical impulse scaling. */
  vx: number;
  vy: number;
  fx: number;
  fy: number;
  bodyFx: number;
  bodyFy: number;
  moment: number;
  longitudinalDemand: number;
  kappa: number | null;
  tanAlpha: number;
  lambda: number | null;
  mode: 'rolling' | 'locked' | 'unloaded';
  ellipseUse: number;
  /** Body contact power. Passive contact must be <=0; propulsion may supply work. */
  power: number;
}

export interface ForceEvaluation {
  fx: number;
  fy: number;
  moment: number;
  wheels: WheelForce[];
  wheelLift: boolean;
}

export interface DynamicStepTrace {
  method: 'four-wheel-dugoff-quasistatic-v1';
  units: Record<string, string>;
  formulas: Record<string, string>;
  sources: ParameterSource[];
  parameters: DynamicVehicleParameters;
  road: DynamicRoad;
  control: DynamicControl;
  initial: DynamicState;
  substepSeconds: number;
  substeps: {
    state: DynamicState;
    forces: ForceEvaluation;
    /** Multiplies every wheel force; preserves the ellipse when stopping at low speed. */
    impulseScale: number;
    /** dt, or time to complete rest if all motion ends inside this substep. */
    motionSeconds: number;
    energyBefore: number;
    energyAfter: number;
  }[];
  limitations: string[];
}
