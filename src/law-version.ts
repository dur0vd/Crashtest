/** Интервалы включают validFrom и не включают validTo: [from, to). */
export interface LawSource {
  url: string;
  docTitle: string;
  revisionDate: string;
}

export interface LawRevision {
  validFrom: string;
  validTo?: string;
  text: string;
  sanction?: string;
  source: LawSource;
  legalCheck?: string;
  effectiveSource?: string;
}

/** Дата календаря места ДТП; часовой пояс не пересчитываем в UTC. */
export function lawDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}(?:$|T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$)/.test(value)) return null;
  if (value.length > 10) {
    const time = value.slice(11).match(/^(\d{2}):(\d{2})(?::(\d{2}))?/)!;
    if (+time[1] > 23 || +time[2] > 59 || +(time[3] ?? 0) > 59) return null;
    if (!Number.isFinite(Date.parse(value))) return null;
  }
  const day = value.slice(0, 10);
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : null;
}

export function revisionAt(revisions: LawRevision[], date: string): LawRevision | undefined {
  const day = lawDate(date);
  if (!day) return undefined;
  const matches = revisions.filter((r) => r.validFrom <= day && (!r.validTo || day < r.validTo));
  // Повреждённые/пересекающиеся данные также не дают права выбрать редакцию молча.
  return matches.length === 1 ? matches[0] : undefined;
}

/** Дословная санкция части статьи, без примечаний об отменённых соседних частях. */
export function sanctionOf(text: string): string | null {
  const body = text.split(/\n\d+(?:\s*[-–]\s*\d+)?\.\s*Утратил/)[0];
  const m = body.match(/(?:^|\n|\s)(?:-|—)?\s*\n?((?:влеч[её]т|наказывается|наказываются)[\s\S]*)$/);
  return m ? m[1].replace(/\n/g, ' ').trim() : null;
}
