import { lawRef } from './law';
import { type Scene, actorLabels } from './scene';
import type { Timeline } from './sim';
import type { Report } from './analysis/types';
import { analyzeTechnical } from './analysis/technical';
import { analyzeRules } from './analysis/traffic-rules';
import { analyzeLegal } from './analysis/legal';
export * from './analysis/types';
export type { Ctx, Info, GateEvent } from './analysis/context';
export { speedLimitAt } from './analysis/traffic-rules';
export { gap } from './analysis/technical';

/** Facts → requirements → provisional legal assessment. */
export function analyze(scene: Scene, tl: Timeline): Report {
  const context = analyzeTechnical(scene, tl);
  const { section: rules, events } = analyzeRules(context);
  const { section: legal, findings } = analyzeLegal(scene, rules);
  const technical = context.technical;
  const { verdicts, duties } = legal;
  const collisions = rules.collisions;
  const summary: string[] = [];
  if (!collisions.length) {
    summary.push('Столкновений не произошло.');
    const v = verdicts.filter((x) => x.status !== 'no-violations').length;
    summary.push(v ? 'Тем не менее у части участников выявлены нарушения ПДД.' : 'Нарушений ПДД не выявлено.');
  } else {
    summary.push(collisions.length === 1 ? `Произошло ДТП: ${collisions[0].title.toLowerCase()}.` : `Произошло ${collisions.length} столкновения.`);
    const causalActors = verdicts.filter((v) => v.status === 'causal-violation');
    const labels = actorLabels(scene);
    if (causalActors.length === 1) summary.push(`Нарушения ПДД, находящиеся в причинной связи с ДТП, допустил(а): ${labels.get(causalActors[0].actorId)}.`);
    else if (causalActors.length > 1) summary.push(`Нарушения, находящиеся в причинной связи с ДТП, допустили: ${causalActors.map((g) => labels.get(g.actorId)).join(', ')}.`);
    else summary.push('Нарушений ПДД в причинной связи со столкновением не выявлено — возможно, ДТП вызвано внешними обстоятельствами или заданы недостаточные данные.');
  }


  const assumptions = [...technical.assumptions, 'Если на перекрёстке нет знаков приоритета и светофора, он считается равнозначным.'];
  const accidentDate = scene.env.accidentDate;
  const ids = new Set([...findings.flatMap(f => f.refs), ...verdicts.flatMap(v => v.legal.flatMap(l => l.refs)), ...duties.flatMap(d => d.refs)]);
  const laws = [...ids].map(id => lawRef(id, /^(koap|uk):/.test(id) ? legal.assessmentDate : accidentDate));
  const legalWarnings = laws.filter(r => r.warning).map(r => `${r.cite}: ${r.warning}`);
  if (legal.assessmentDate !== accidentDate) legalWarnings.push(`Дата правовой оценки ${legal.assessmentDate} задана отдельно от даты ДТП ${accidentDate}.`);
  if (legalWarnings.length) summary.push('Правовая квалификация предварительная: есть пробелы или неподтверждённые сроки действия редакций. См. предупреждения о нормах.');
  return { accidentDate, laws, legalWarnings, technical, rules, legal, hasCollision: collisions.length > 0, summary, events, findings, collisions, verdicts, duties, assumptions };
}
