import { analyzeTechnical } from '../analysis/technical';
import { analyzeRules } from '../analysis/traffic-rules';
import { analyzeLegal } from '../analysis/legal';
import type { Report } from '../analysis/types';
import { lawRef } from '../law';
import { lawDate } from '../law-version';
import { DT, type Timeline } from '../sim';
import type { FeatureIssue, FeatureResult, PhysicsOutput, ProjectEnvelope, RulesPort } from '../parallel/contracts';
import { describeLighting, validateLighting } from './lighting';
import { describeMobility, validateMobility } from './mobility';
import { describePassengerSupplement, validatePassengerSupplement } from './passengers';
import { describeStopping, validateStoppingSupplement } from './stopping';
import { applyExpertResults, describeExpert, prepareExpertContext, readExpertEvidence } from './expert';
import { jsonSafe, object } from './facts';

function timelineIssues(project: ProjectEnvelope, timeline: Timeline): FeatureIssue[] {
  if (timeline.dt !== DT) return [{ code: 'rules.timeline-step', message: `Версия 1 правил использует Timeline с шагом ${DT} с. Получен другой шаг; пересчёт времени не подменяется.` }];
  if (!Number.isInteger(timeline.n) || timeline.n <= 0) return [{ code: 'rules.empty-timeline', message: 'Нет наблюдаемых кадров Timeline.' }];
  const issues: FeatureIssue[] = [];
  for (const a of project.scene.actors) {
    const tr = timeline.tracks.get(a.id);
    if (!tr || [tr.x, tr.y, tr.h, tr.v, tr.present, tr.free].some(values => values.length !== timeline.n))
      issues.push({ code: 'rules.missing-track', message: `Отсутствует полный наблюдаемый трек ${a.id}.` });
    else if ([tr.x, tr.y, tr.h, tr.v].some(values => values.some(v => !Number.isFinite(v))))
      issues.push({ code: 'rules.invalid-track', message: `Трек ${a.id} содержит нечисловые наблюдения.` });
  }
  return issues;
}

/** Stable v1 adapter. No DOM, imports of other chats, replacement simulation,
 * fabricated physical result, or percentage allocation of fault. */
export function createRulesPort(): RulesPort {
  return {
    contractVersion: 1,
    describe(project) { return [describeLighting(project), describeMobility(project), describePassengerSupplement(project), describeStopping(project), describeExpert(project)]; },
    async evaluate(project: ProjectEnvelope, timeline: Timeline, physical?: PhysicsOutput): Promise<FeatureResult<Report>> {
      if (project.contractVersion !== 1) return { status: 'unsupported', issues: [{ code: 'rules.contract-version', message: 'Поддерживается контракт версии 1.' }] };
      const rulesInput = object(project.extensions.rules);
      const issues = [...validateLighting(rulesInput.lighting), ...validateMobility(rulesInput.mobility), ...validatePassengerSupplement(rulesInput.passengers), ...validateStoppingSupplement(rulesInput.stopping), ...timelineIssues(project, timeline)];
      if (!lawDate(project.scene.env.accidentDate)) issues.push({ code: 'rules.accident-date', message: 'Требуется корректная локальная дата ДТП.', path: '/scene/env/accidentDate' });
      if (rulesInput.mode != null && !['expert', 'educational'].includes(String(rulesInput.mode))) issues.push({ code: 'rules.mode', path: '/extensions/rules/mode', message: 'Неизвестный режим правил.' });
      if (issues.length) return { status: 'insufficient-data', issues };
      const scene = project.scene;
      const context = analyzeTechnical(scene, timeline);
      const expert = rulesInput.mode !== 'educational';
      const scientific = readExpertEvidence(project, timeline, physical);
      if (expert) prepareExpertContext(context, scientific, physical);
      // Even missing light observations remain unknown in this public port.
      const { section: rules, events } = analyzeRules(context, { lighting: object(rulesInput.lighting), mobility: object(rulesInput.mobility), passengers: object(rulesInput.passengers), stopping: object(rulesInput.stopping) });
      if (expert) applyExpertResults(project, rules, scientific);
      const { section: legal, findings } = analyzeLegal(scene, rules);
      const refs = new Set([...findings.flatMap(f => f.refs), ...legal.verdicts.flatMap(v => v.legal.flatMap(l => l.refs)), ...legal.duties.flatMap(d => d.refs)]);
      const laws = [...refs].map(ref => lawRef(ref, /^(koap|uk):/.test(ref) ? legal.assessmentDate : scene.env.accidentDate));
      const legalWarnings = laws.filter(ref => ref.warning).map(ref => `${ref.cite}: ${ref.warning}`);
      if (legal.assessmentDate !== scene.env.accidentDate) legalWarnings.push(`Дата правовой оценки ${legal.assessmentDate} отличается от даты ДТП ${scene.env.accidentDate}.`);
      const summary = [rules.collisions.length ? `Наблюдалось столкновений: ${rules.collisions.length}.` : 'Столкновений не наблюдалось.',
        legal.verdicts.some(v => v.status.endsWith('violation')) ? 'Установлены нарушения отдельных требований; причинная связь оценивается отдельно.'
          : legal.verdicts.some(v => v.status === 'insufficient-data') ? 'Для полной оценки соблюдения требований недостаточно данных.' : 'Нарушений в пределах проверенных требований не выявлено.'];
      const report: Report = { accidentDate: scene.env.accidentDate, laws, legalWarnings, technical: context.technical, rules, legal,
        hasCollision: rules.collisions.length > 0, summary, events: expert ? rules.findings.filter(f => f.t !== undefined).map(f => ({ t: f.t!, text: `${f.actorId}: ${f.title}` })).sort((a, b) => a.t - b.t) : events, findings, collisions: rules.collisions, verdicts: legal.verdicts,
        duties: legal.duties, assumptions: [...context.technical.assumptions,
          'Световые наблюдения заданы на заявленный период; неизвестный прибор не равен выключенному.',
          expert ? 'Экспертный режим: научные доказательства принимаются через PhysicsOutput; выводы ограничены их источниками и предпосылками.' : 'Учебный режим: прежние упрощённые расчёты; экспертная достоверность не заявлена.'] };
      return { status: 'ok', value: jsonSafe(report), issues: [...(expert ? scientific.issues : []), ...legalWarnings.map(message => ({ code: 'rules.legal-source-warning', message }))] };
    },
  };
}
