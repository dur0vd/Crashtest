import { type LawRevision, revisionAt } from './law-version';
import pdd from './data/pdd.json';
import signs from './data/signs.json';
import markings from './data/markings.json';
import koap from './data/koap.json';
import uk from './data/uk.json';
export { sanctionOf } from './law-version';

// Полные тексты и история редакций норм. Корпус доступен синхронно для отчётов.
// Источник и порядок обновления — tools/fetch-law.py и tools/build-law.py.

export interface PddPoint {
  id: string;
  text: string;
  revisions: LawRevision[];
  legalCheck?: string;
}
export interface PddSection {
  id: string;
  title: string;
  points: PddPoint[];
}
export interface PddData {
  fetched: string;
  sources: Record<string, string>;
  sections: PddSection[];
  basics: { title: string; points: PddPoint[] } | null;
  faults: { id: string; title: string; items: PddPoint[] }[];
  notes: { title: string; text: string }[];
}

export interface SignItem {
  id: string;
  title: string;
  text: string;
  revisions?: LawRevision[];
  legalCheck?: string;
  group: number;
  img?: string;
  imgs?: string[];
}
export interface SignGroup {
  id: string;
  title: string;
  intro: string;
  signs: SignItem[];
  notes: string[];
}
export interface SignsData {
  groups: SignGroup[];
}
export interface MarkingsData {
  horizontal: { title: string; items: SignItem[]; notes: string[] } | null;
  vertical: { title: string; items: SignItem[]; notes: string[] } | null;
}

export interface Article {
  id: string;
  title: string;
  repealed: boolean;
  intro: string[];
  parts: { n: string; text: string; revisions: LawRevision[]; legalCheck?: string }[];
  notes: string[];
}
export interface CodeData {
  code: string;
  chapter: string;
  articles: Article[];
  fetched: string;
}

export interface Corpus {
  pdd: PddData;
  signs: SignsData;
  markings: MarkingsData;
  koap: CodeData;
  uk: CodeData;
}

// Синхронный корпус нужен и при сериализации отчёта (включая будущий PDF).
export const corpus: Corpus = { pdd, signs, markings, koap, uk } as unknown as Corpus;
export function loadCorpus(): Promise<Corpus> { return Promise.resolve(corpus); }

export interface Resolved {
  /** «п. 9.10 ПДД РФ», «ч. 2 ст. 12.9 КоАП РФ», «знак 2.5» */
  cite: string;
  title: string;
  text: string;
  sanction: string | null;
  revision?: LawRevision;
  warning?: string;
  images: string[];
  /** вкладка и запрос для «Открыть в справочнике» */
  where: { tab: RefTab; query: string };
}

export type RefTab = 'pdd' | 'signs' | 'markings' | 'koap' | 'uk';

function splitArticleRef(rest: string): { article: string; part: string } {
  // «12.9.2» — статья 12.9, часть 2; «12.21#1» — явная запись; «264.1» — статья 264, часть 1
  if (rest.includes('#')) {
    const [article, part] = rest.split('#');
    return { article, part };
  }
  const tokens = rest.split('.');
  if (/^12$/.test(tokens[0])) return { article: tokens.slice(0, 2).join('.'), part: tokens.slice(2).join('.') };
  return { article: tokens[0], part: tokens.slice(1).join('.') };
}

/** Полная история нормы; принадлежность источнику не зависит от выбранной даты. */
export function revisionsFor(id: string, c: Corpus = corpus): LawRevision[] {
  const kind = id.slice(0, id.indexOf(':'));
  const rest = id.slice(id.indexOf(':') + 1);
  if (kind === 'pdd') {
    const points = rest.startsWith('op:') ? c.pdd.basics?.points ?? [] : c.pdd.sections.flatMap((s) => s.points);
    return points.find((p) => p.id === rest.replace(/^op:/, ''))?.revisions ?? [];
  }
  if (kind === 'sign') return c.signs.groups.flatMap((g) => g.signs).find((s) => s.id === rest)?.revisions ?? [];
  if (kind === 'marking') return [...(c.markings.horizontal?.items ?? []), ...(c.markings.vertical?.items ?? [])].find((s) => s.id === rest)?.revisions ?? [];
  if (kind === 'koap' || kind === 'uk') {
    const { article, part } = splitArticleRef(rest);
    const a = c[kind].articles.find((a) => a.id === article);
    return (a?.parts.find((p) => p.n === part) ?? (part === '' && a?.parts.length === 1 ? a.parts[0] : undefined))?.revisions ?? [];
  }
  return [];
}

export function resolveRef(c: Corpus, id: string, date: string): Resolved | null {
  const version = (node: { revisions?: LawRevision[]; legalCheck?: string }) => {
    const revision = revisionAt(node.revisions ?? [], date);
    return {
      text: revision?.text ?? '', sanction: revision?.sanction ?? null, revision,
      warning: revision?.legalCheck ?? (!revision ? `TODO(legal-check): нет редакции ${id} на дату ${date}. ${node.legalCheck ?? ''}` : undefined),
    };
  };
  const [kind, rest] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  if (kind === 'pdd') {
    for (const s of c.pdd.sections) {
      const p = s.points.find((x) => x.id === rest);
      if (p) return { cite: `п. ${p.id} ПДД РФ`, title: s.title, ...version(p), images: [], where: { tab: 'pdd', query: p.id } };
    }
    const op = c.pdd.basics?.points.find((x) => x.id === rest.replace(/^op:/, ''));
    if (rest.startsWith('op:') && op) return { cite: `п. ${op.id} Основных положений`, title: c.pdd.basics!.title, ...version(op), images: [], where: { tab: 'pdd', query: op.id } };
    return null;
  }
  if (kind === 'sign' || kind === 'marking') {
    const list =
      kind === 'sign'
        ? c.signs.groups.flatMap((g) => g.signs)
        : [...(c.markings.horizontal?.items ?? []), ...(c.markings.vertical?.items ?? [])];
    const it = list.find((x) => x.id === rest);
    if (!it) return null;
    return {
      cite: `${kind === 'sign' ? 'знак' : 'разметка'} ${it.id}`,
      title: it.title,
      ...version(it),
      images: it.imgs ?? (it.img ? [it.img] : []),
      where: { tab: kind === 'sign' ? 'signs' : 'markings', query: it.id },
    };
  }
  if (kind === 'koap' || kind === 'uk') {
    const data = kind === 'koap' ? c.koap : c.uk;
    const { article, part } = splitArticleRef(rest);
    const a = data.articles.find((x) => x.id === article);
    if (!a) return null;
    const p = a.parts.find((x) => x.n === part) ?? (part === '' && a.parts.length === 1 ? a.parts[0] : undefined);
    if (!p) return null;
    const label = p.n ? `ч. ${p.n} ст. ${a.id}` : `ст. ${a.id}`;
    return { cite: `${label} ${data.code}`, title: a.title, ...version(p), images: [], where: { tab: kind, query: a.id } };
  }
  return null;
}

/** Адрес картинки знака или разметки из каталога public. */
export const imgUrl = (path: string): string => `${import.meta.env.BASE_URL}${path}`;
