import { diagnostics } from '../workbench/diagnostics';
import type { Report } from '../analysis/types';
import type { CalculationRecord, JsonValue } from '../parallel/contracts';
import type { ProjectFile } from '../project/model';
import { canonical, sha256 } from '../project/canonical';
import { inputHash } from '../project/model';
export type ReportTemplate = 'commissioner' | 'specialist' | 'training';
export const REPORT_TITLES: Record<ReportTemplate, string> = {
  commissioner: 'Справка аварийного комиссара',
  specialist: 'Расчёт для специалиста',
  training: 'Учебный разбор',
};
export interface ReportQuestion {
  text: string;
  calculationIds: string[];
}
export interface ReportOptions {
  template: ReportTemplate;
  author: string;
  request: string;
  date: string;
  questions: ReportQuestion[];
  includeLegal?: boolean;
}
export interface ReportSection {
  title: string;
  lines: string[];
}
export interface ReportDocument {
  title: string;
  sections: ReportSection[];
  inputHash: string;
  text: string;
  figures: ReportFigure[];
}
const clean = (s: string): string =>
  s.replace(/виновен/giu, '[оценочная формулировка исключена]');
const show = (v: unknown): string => clean(canonical(v));
/** Text answers are generated exclusively from supplied calculations. Rule/legal
 * contents come exclusively from a supplied Report. No normative prose invented.
 */
export async function reportDocument(
  file: ProjectFile,
  calculations: CalculationRecord[],
  report: Report | undefined,
  options: ReportOptions,
): Promise<ReportDocument> {
  const hash = await inputHash(file.project),
    sections: ReportSection[] = [];
  sections.push({
    title: 'Запрос и вопросы',
    lines: [
      `Автор: ${options.author || 'не указан'}`,
      `Дата: ${options.date}`,
      `Запрос: ${options.request || 'не указан'}`,
      ...options.questions.map((q, i) => `${i + 1}. ${q.text}`),
    ],
  });
  sections.push({
    title: 'Материалы и исходные данные',
    lines: [
      `SHA-256 входов: ${hash}`,
      `Версии: ${show(file.versions)}`,
      `Дата ДТП: ${file.project.scene.env.accidentDate}`,
      ...(await Promise.all(
        file.attachments.map(
          async (a) =>
            `${a.id}: ${a.name}; ${a.bytes.length} байт; SHA-256 ${await sha256(a.bytes)}`,
        ),
      )),
      `Измеренные наблюдения: ${show(file.project.evidence)}`,
      `Физические параметры и диапазоны: ${show(file.project.extensions.physics)}`,
      `Установленные правовые факты: ${show(file.project.extensions.rules)}`,
    ],
  });
  sections.push({
    title: 'Technical — методы и расчёты',
    lines: calculations.length
      ? calculations.flatMap((c) => [
          `Calculation-ID: ${c.id}; метод: ${c.method}`,
          `Формула: ${c.formula}`,
          `Подстановка / входы: ${show(c.inputs)}`,
          `Результат / промежуточные данные: ${show(c.result)}`,
          `Единицы: ${show(c.units)}`,
          `Источники: ${c.sources.join('; ') || 'не указаны'}`,
          `Допущения и пределы: ${c.assumptions.join('; ') || 'не указаны'}`,
        ])
      : ['Расчёт недоступен или не выполнен. Численные выводы отсутствуют.'],
  });
  if (report)
    sections.push({
      title: 'Technical — переданный Report и trace',
      lines: [
        ...report.technical.assumptions,
        ...report.technical.events.map(
          (e) => `${e.t} с: ${e.text}; trace ${show(e.trace)}`,
        ),
        ...report.technical.collisions.map((c) => `Контакт: ${show(c)}`),
      ],
    });
  const ids = new Map(calculations.map((c) => [c.id, c]));
  sections.push({
    title: 'Ответы на вопросы',
    lines: options.questions.map((q, i) => {
      const linked = q.calculationIds.map((id) => ids.get(id));
      if (!linked.length || linked.some((c) => !c))
        return `${i + 1}. ${q.text} — недостаточно данных: нет действительного calculation-ID.`;
      return `${i + 1}. ${q.text} — ${linked.map((c) => `[${c!.id}] ${show(c!.result)}; единицы ${show(c!.units)}; пределы: ${c!.assumptions.join('; ') || 'не указаны'}`).join(' | ')}`;
    }),
  });
  sections.push({
    title: 'Rules — соответствие действий ПДД',
    lines: report
      ? [
          `Дата ДТП / редакции: ${report.accidentDate}; ${show(report.laws)}`,
          ...report.rules.findings.map(
            (f) =>
              `${f.requirement}: ${f.compliance}. ${f.detail}; источники ${f.refs.join(', ')}; trace ${show(f.trace)}`,
          ),
        ]
      : [
          'Правовой порт не подключён или Report не передан; выводы недоступны.',
        ],
  });
  if (options.includeLegal === true)
    sections.push({
      title: 'Legal — переданная правовая оценка',
      lines: report
        ? [
            `Дата оценки ${report.legal.assessmentDate}, редакция ${report.legal.editionDate}`,
            ...report.legalWarnings,
            ...report.legal.verdicts.flatMap((v) =>
              v.legal.map(
                (l) =>
                  `${l.text}; ссылки ${l.refs.join(', ')}; trace ${show(l.trace)}`,
              ),
            ),
          ]
        : ['Нет Report от RulesPort; правовая оценка недоступна.'],
    });
  sections.push({
    title: 'Журнал и ограничения',
    lines: [
      `Журнал: ${show(file.journal)}`,
      'Документ отражает переданные данные и пределы методов. Не подтверждает натурную валидацию или процессуальный статус заключения.',
      'TODO(legal-check): сверить структуру и обязательные реквизиты для конкретного вида документа и юрисдикции.',
    ],
  });
  for (const section of sections) {
    section.title = clean(section.title);
    section.lines = section.lines.map(clean);
  }
  const figures = diagnostics(calculations).figures;
  if (figures.length)
    sections.splice(3, 0, {
      title: 'Графики из расчётов',
      lines: figures.map(
        (f) =>
          `${f.title} [${f.calculationId}]; X: ${f.xUnit ?? f.unit}, Y: ${f.yUnit ?? 'единицы не предоставлены'}; точки ${show(f.points)}`,
      ),
    });
  const title = REPORT_TITLES[options.template];
  return {
    title,
    sections,
    inputHash: hash,
    figures,
    text: [title, ...sections.flatMap((s) => [s.title, ...s.lines])].join('\n'),
  };
}
/** Reusable chart payload: values must come from an identified calculation. */
export interface ReportFigure {
  calculationId: string;
  title: string;
  unit: string;
  xUnit?: string;
  yUnit?: string;
  points: { x: number; y: number }[];
  kind: 'line' | 'histogram' | 'tornado';
}
export function figureData(record: CalculationRecord): JsonValue {
  return record.result;
}
