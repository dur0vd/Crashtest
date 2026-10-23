import type { Calculator } from './common';
import { brakingCalculator } from './braking';
import { skidCalculator } from './skid';
import { criticalSpeedCalculator } from './critical-speed';
import { throwCalculator } from './throw';
import { momentumCalculator } from './momentum';
import { eesCalculator } from './ees';

export * from './common';
export { brakingCalculator, skidCalculator, criticalSpeedCalculator, throwCalculator, momentumCalculator, eesCalculator };
export { solveMomentum } from './momentum';

/** expert.lateral is the lateral-slide form of expert.skid (same energy method). */
export const lateralCalculator: Calculator = { ...skidCalculator, id: 'expert.lateral', title: 'Скорость по следу бокового скольжения (поперечный юз)' };

export const CALCULATORS: Record<string, Calculator> = Object.fromEntries([
  brakingCalculator, skidCalculator, lateralCalculator, criticalSpeedCalculator, throwCalculator, momentumCalculator, eesCalculator,
].map(c => [c.id, c]));
