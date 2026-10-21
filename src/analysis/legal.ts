import { corpus } from '../corpus';
import { lawRef } from '../law';
import { type Scene, type Actor, type VehicleType, VEHICLES } from '../scene';
import { HARM_LABEL, harmRank, type HarmLevel, type CollisionReport, type ActorVerdict, type LegalInput, type LegalSection, type Finding, type RulesSection } from './types';

function harmToAll(reports: CollisionReport[]): Map<string, HarmLevel> {
  const m = new Map<string, HarmLevel>();
  for (const r of reports) {
    for (const h of r.harm) {
      const cur = m.get(h.actorId) ?? 'none';
      if (harmRank(h.level) > harmRank(cur)) m.set(h.actorId, h.level);
    }
  }
  return m;
}

function buildVerdicts(scene: Scene, rules: RulesSection, findings: Finding[]): ActorVerdict[] {
  const reports = rules.collisions;
  const harm = harmToAll(reports);
  const verdicts: ActorVerdict[] = [];
  const hasCollision = reports.length > 0;

  for (const a of scene.actors) {
    if (a.railwayTrain) {
      const state = rules.actors.find(v => v.actorId === a.id)!;
      // TODO(legal-check): обязанности машиниста и железнодорожные составы
      // ответственности требуют отдельного корпуса; трамвайный тип — только носитель колеи.
      const trace = { actorId: a.id, subject: subjectOf(a), legalScope: 'railway-not-implemented' };
      verdicts.push({ actorId: a.id, status: state.status, text: state.text,
        legal: [{ refs: [], text: 'Правовая оценка действий машиниста не реализована; дорожные составы для водителя трамвая к поезду не применяются. TODO(legal-check): отдельные железнодорожные нормы.', trace }], trace });
      continue;
    }
    const isVeh = a.kind === 'vehicle';
    const mine = findings.filter((f) => f.actorId === a.id);
    const viol = mine.filter((f) => f.severity === 'violation');
    const causal = viol.filter((f) => f.causal);
    const legal: LegalInput[] = [];

    const spec = isVeh ? VEHICLES[a.type as VehicleType] : null;
    const mechanical = !!spec?.motorized && !!spec?.licenseRequired;
    const noLicense = !!spec?.licenseRequired && a.flags.noLicense;

    // последствия для других участников (учитываются, если установлена причинная связь)
    const consequences: LegalInput[] = [];
    let criminal = false;
    if (isVeh && causal.length) {
      let worst: HarmLevel = 'none';
      let fatalCount = 0;
      for (const [id, lv] of harm) {
        if (id === a.id) continue;
        if (harmRank(lv) > harmRank(worst)) worst = lv;
        if (lv === 'fatal') fatalCount++;
      }
      const agg = a.flags.drunk || noLicense || a.flags.flees;
      const aggText = [a.flags.drunk && 'опьянение', noLicense && 'отсутствие права управления', a.flags.flees && 'оставление места ДТП'].filter(Boolean).join(', ');
      const est = 'по расчётной оценке тяжести вреда';
      if (mechanical && worst === 'light') consequences.push({ refs: ['koap:12.24.1'], text: `${est}: нарушение ПДД, повлёкшее лёгкий вред здоровью` });
      else if (mechanical && worst === 'medium') consequences.push({ refs: ['koap:12.24.2'], text: `${est}: нарушение ПДД, повлёкшее вред здоровью средней тяжести` });
      else if (!mechanical && (worst === 'severe' || worst === 'fatal')) {
        // TODO(legal-check): проверить разграничение со ст. 268 УК для иных участников движения.
        consequences.push({ refs: [worst === 'severe' ? 'uk:118.1' : fatalCount >= 2 ? 'uk:109.3' : 'uk:109.1'], text: `${est}: ориентир — причинение тяжкого вреда / смерти по неосторожности; TODO(legal-check): требуется юридическая проверка, включая ст. 268 УК` });
      } else if (worst === 'severe') {
        criminal = true;
        consequences.push({ refs: [agg ? 'uk:264.2' : 'uk:264.1'], text: `${est}: нарушение ПДД, повлёкшее тяжкий вред здоровью${agg ? ` (отягчающие: ${aggText})` : ''}` });
      } else if (worst === 'fatal') {
        criminal = true;
        const id = fatalCount >= 2 ? (agg ? 'uk:264.6' : 'uk:264.5') : agg ? 'uk:264.4' : 'uk:264.3';
        consequences.push({ refs: [id], text: `${est}: нарушение ПДД, повлёкшее смерть${fatalCount >= 2 ? ' двух и более лиц' : ' человека'}${agg ? ` (отягчающие: ${aggText})` : ''}` });
      } else if (worst === 'none' && hasCollision) {
        consequences.push({ refs: ['gk:1064', 'gk:1079'], text: `вред здоровью другим участникам маловероятен${harm.get(a.id) && harm.get(a.id) !== 'none' ? `; самому водителю — ${HARM_LABEL[harm.get(a.id)!]} (на квалификацию по ст. 12.24 / 264 не влияет)` : ''}: имущественный ущерб возмещается в гражданско-правовом порядке (ОСАГО)` });
      }
      if (mechanical && worst !== 'none') {
        const parts = agg ? [2, 4, 6] : [1, 3, 5];
        consequences.push({
          refs: ['koap:12.24.1', 'koap:12.24.2', ...parts.map((p) => `uk:264.${p}`)],
          text: `Окончательная квалификация зависит от тяжести вреда по заключению судебно-медицинской экспертизы: лёгкий — ст. 12.24 ч. 1 КоАП; средней тяжести — ч. 2 той же статьи; тяжкий вред — ч. ${parts[0]} ст. 264 УК; смерть — ч. ${parts[1]} ст. 264 УК; смерть двух и более лиц — ч. ${parts[2]} ст. 264 УК${agg ? ` (отягчающие: ${aggText})` : ''}`,
        });
      }
    }

    // КС РФ, позиция 2023 г.: недопустима двойная ответственность по ст. 12.24
    // и иной статье гл. 12 КоАП за одно причинное нарушение.
    // https://www.ksrf.ru/ru/Decision/Pages/default.aspx
    // TODO(legal-check): реквизиты постановления; проверить применение к ст. 264 УК.
    const absorbedBy = consequences.find((l) => l.refs.some((r) => r.startsWith('koap:12.24.') || r.startsWith('uk:264.')));
    const seen = new Set<string>();
    for (const f of viol) {
      if (f.causal && absorbedBy) {
        legal.push({ refs: [...f.refs.filter((r) => !r.startsWith('koap:')), ...absorbedBy.refs], text: `${f.title} — нарушение ПДД, образующее объективную сторону ст. ${absorbedBy.refs[0].startsWith('uk:') ? '264 УК' : '12.24 КоАП'}` });
        continue;
      }
      for (const r of f.refs) {
        if (r.startsWith('koap:') && !seen.has(r)) {
          seen.add(r);
          legal.push({ refs: [r], text: f.title });
        }
      }
    }

    // водитель-нарушитель: опьянение, права, оставление места
    if (isVeh) {
      if (a.flags.drunk && mechanical) {
        legal.push(
          criminal
            ? { refs: ['pdd:2.7'], text: 'управление в состоянии опьянения — отягчающее обстоятельство по ст. 264 УК РФ' }
            : { refs: ['pdd:2.7', 'koap:12.8.1'], text: 'управление в состоянии опьянения' },
        );
      }
      if (noLicense) legal.push({ refs: ['koap:12.7.1'], text: 'управление без права управления' });
      if (mechanical && a.flags.flees && hasCollision) {
        legal.push(
          criminal
            ? { refs: ['pdd:2.5'], text: 'оставление места ДТП — отягчающее обстоятельство по ст. 264 УК РФ' }
            : { refs: ['pdd:2.5', 'koap:12.27.2'], text: 'оставление места ДТП' },
        );
      }
    }
    legal.push(...consequences);

    const { status, text } = rules.actors.find(v => v.actorId === a.id)!;
    const subject = subjectOf(a);
    const trace = { actorId: a.id, subject, flags: { ...a.flags }, findings: mine.map(f => f.trace), harm: Object.fromEntries(harm) };
    verdicts.push({ actorId: a.id, status, text, legal: legal.map(l => ({ ...l, trace })), trace });
  }
  return verdicts;
}

function buildDuties(scene: Scene, reports: CollisionReport[]): LegalInput[] {
  if (!reports.length) return [];
  if (!scene.actors.some(a => a.kind === 'vehicle' && !a.railwayTrain
    && reports.some(r => r.collision.a === a.id || r.collision.b === a.id))) return [];
  const harm = harmToAll(reports);
  const anyHarm = [...harm.values()].some((h) => h !== 'none');
  const out: LegalInput[] = [
    { refs: ['pdd:2.5'], text: 'Немедленно остановить ТС, включить аварийную сигнализацию, выставить знак аварийной остановки, ничего не перемещать на месте ДТП.' },
  ];
  if (anyHarm) {
    out.push({ refs: ['pdd:2.6'], text: 'Если есть пострадавшие: оказать первую помощь, вызвать скорую помощь и полицию, записать данные очевидцев, дождаться сотрудников полиции.' });
  } else {
    out.push({ refs: ['pdd:2.6.1', 'osago:11.1'], text: 'Если вред причинён только имуществу: зафиксировать обстановку, при создании помех освободить проезжую часть; оформить ДТП с полицией или без неё (европротокол) при выполнении условий закона об ОСАГО.' });
  }
  out.push({ refs: ['koap:12.27.1', 'koap:12.27.2'], text: 'Невыполнение этих обязанностей, а тем более оставление места ДТП, влечёт самостоятельную ответственность.' });
  return out;
}


/** Subject properties belong to qualification, never to the kinematic stage. */
export function subjectOf(a: Actor) {
  const spec = a.kind === 'vehicle' ? VEHICLES[a.type as VehicleType] : null;
  const age = a.age ?? (a.kind === 'pedestrian' && a.type === 'child' ? null : 18);
  return { roadSubject: !a.railwayTrain, motorized: !!spec?.motorized, licenseRequired: !a.railwayTrain && !!spec?.licenseRequired, age,
    ageAssumed: a.age === undefined && age !== null,
    administrativeSubject: !a.railwayTrain && age !== null ? age >= 16 : false,
  };
}

const RULE_OFFENCES: Record<string, string> = {
  'rule:signal': 'koap:12.12.1',
  'rule:intersection-priority': 'koap:12.13.2',
  'rule:intersection-blockage': 'koap:12.13.1',
  'rule:maneuver-priority': 'koap:12.14.3',
  'rule:indicator': 'koap:12.14#1',
  'rule:extreme-position': 'koap:12.14#1.1',
  'rule:forbidden-maneuver': 'koap:12.14#2',
  'rule:motorway-maneuver': 'koap:12.11#3',
  'rule:obstacle-bypass': 'koap:12.15#3',
  'rule:slow-vehicle-yield': 'koap:12.15#1.1',
  'rule:meeting-priority': 'koap:12.15#1',
  'rule:road-position': 'koap:12.15#1',
  'rule:railway-prohibited-entry': 'koap:12.10#1',
  'rule:railway-stop': 'koap:12.10#1',
  'rule:railway-outside': 'koap:12.10#1',
  'rule:railway-other': 'koap:12.10#2',
  'rule:spacing': 'koap:12.15.1',
  'rule:sidewalk': 'koap:12.15.2',
  'rule:opposing-lane': 'koap:12.15.4',
  'rule:sign-requirement': 'koap:12.16.1',
  'rule:turn-sign': 'koap:12.16.2',
  'rule:one-way': 'koap:12.16.3',
  'rule:parking-sign': 'koap:12.16.4',
  'rule:truck-sign': 'koap:12.16.6',
  'rule:pedestrian-priority': 'koap:12.18',
  'rule:pedestrian-crossing': 'koap:12.29.1',
  'rule:nonmotor-road': 'koap:12.29.2',
  'rule:cargo': 'koap:12.21#1',
  'rule:weight': 'koap:12.21.1#11',
  'rule:dangerous-cargo': 'koap:12.21.2#2',
};

function legalRefs(f: Finding, a: Actor): string[] {
  const subject = subjectOf(a);
  const codes = (f.trace.ruleCodes ?? []) as string[];
  const refs = codes.flatMap(code => {
    // Respect the exclusions expressly named in 12.14(2) and 12.15(4).
    if (code === 'rule:forbidden-maneuver' && (codes.includes('rule:motorway-maneuver') || codes.includes('rule:turn-sign'))) return [];
    if (code === 'rule:opposing-lane' && codes.includes('rule:obstacle-bypass')) return [];
    if (code === 'rule:maneuver-priority' && codes.includes('rule:intersection-priority')) return [];
    if (code === 'rule:speed') {
      const excess = Number(f.trace.excess);
      return excess > 80 ? ['koap:12.9.5'] : excess > 60 ? ['koap:12.9.4'] : excess > 40 ? ['koap:12.9.3'] : excess > 20 ? ['koap:12.9.2'] : [];
    }
    return RULE_OFFENCES[code] ? [RULE_OFFENCES[code]] : [];
  });
  if (!subject.administrativeSubject) return [...f.refs];
  return [...new Set([...f.refs, ...refs.map(r => a.kind === 'vehicle' && !subject.motorized
    ? a.flags.drunk ? 'koap:12.29.3' : 'koap:12.29.2' : r)])];
}

/** The bundled legal edition is explicit; unsupported dates get no invented sanctions. */
export const LEGAL_EDITION_DATE = corpus.koap.fetched;
export const DEFAULT_ASSESSMENT_DATE = LEGAL_EDITION_DATE;

export function analyzeLegal(scene: Scene, rules: RulesSection): { section: LegalSection; findings: Finding[] } {
  const findings = rules.findings.map(f => ({ ...f, refs: legalRefs(f, scene.actors.find(a => a.id === f.actorId)!) }));
  const assessmentDate = scene.analysisDate ?? scene.env.accidentDate;
  const verdicts = buildVerdicts(scene, rules, findings);
  for (const verdict of verdicts) {
    const a = scene.actors.find(a => a.id === verdict.actorId)!;
    const subject = subjectOf(a);
    if (!a.railwayTrain && !subject.administrativeSubject) {
      verdict.legal = verdict.legal.map(l => ({ ...l, refs: l.refs.filter(r => !r.startsWith('koap:')) })).filter(l => l.refs.length);
      verdict.legal.push({ refs: [], text: a.type === 'child' && a.age === undefined
        ? 'Возраст ребёнка не задан: административная квалификация не определяется; дети до 16 лет не являются субъектами КоАП.'
        : 'Лицо младше 16 лет не является субъектом административной ответственности (ст. 2.3 КоАП РФ).', trace: { subject } });
    }
    for (const item of verdict.legal) {
      item.sanctions = sanctionsFor(item.refs, assessmentDate);
      item.trace = { ...item.trace, assessmentDate, editionDate: LEGAL_EDITION_DATE };
    }
  }
  const duties = buildDuties(scene, rules.collisions).map(l => ({ ...l,
    trace: { collisions: rules.collisions.map(c => c.trace), assessmentDate, editionDate: LEGAL_EDITION_DATE },
    sanctions: sanctionsFor(l.refs, assessmentDate),
  }));
  return { section: { assessmentDate, editionDate: LEGAL_EDITION_DATE, verdicts, duties }, findings };
}

/** Each sanction comes from the part selected for the assessment date, never a current snapshot fallback. */
function sanctionsFor(refs: string[], date: string) {
  return refs.filter(ref => ref.startsWith('koap:') || ref.startsWith('uk:')).map(ref => {
    const selected = lawRef(ref, date);
    const text = selected.sanction ?? null;
    return { ref, text, editionDate: selected.source?.revisionDate ?? '', available: text !== null,
      warning: selected.warning, revision: selected.revision, source: selected.source };
  });
}
