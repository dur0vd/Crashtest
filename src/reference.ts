import { type Article, type Corpus, type RefTab, type SignItem, imgUrl, loadCorpus, resolveRef } from './corpus';
import { h } from './ui';

// Справочник: ПДД (с основными положениями и перечнем неисправностей), знаки, разметка, КоАП гл. 12, УК гл. 27.

interface RefState {
  tab: RefTab;
  query: string;
  limit: number;
  focus: string;
}

export const refState: RefState = { tab: 'pdd', query: '', limit: 60, focus: '' };

const TABS: [RefTab, string][] = [
  ['pdd', 'ПДД'],
  ['signs', 'Знаки'],
  ['markings', 'Разметка'],
  ['koap', 'КоАП'],
  ['uk', 'УК'],
];

const norm = (s: string): string => s.toLowerCase().replace(/ё/g, 'е');

function matches(query: string, id: string, ...texts: string[]): boolean {
  const q = norm(query.trim());
  if (!q) return true;
  const hay = norm(`${id} ${texts.join(' ')}`);
  return q.split(/\s+/).every((t) => hay.includes(t));
}

/** Номер, введённый целиком («9.10»), должен находить именно этот пункт первым. */
function rank(query: string, id: string): number {
  const q = query.trim();
  if (!q) return 0;
  if (id === q) return 0;
  if (id.startsWith(q + '.') || id.startsWith(q + '(')) return 1;
  if (id.startsWith(q)) return 2;
  return 3;
}

function paragraphs(text: string): HTMLElement[] {
  return text.split('\n').map((l) => h('p', {}, l));
}

export function buildReference(root: HTMLElement, onOpenRef?: () => void): void {
  void onOpenRef;
  root.replaceChildren(h('p', { class: 'note' }, 'Загружаю тексты норм…'));
  loadCorpus().then((c) => render(root, c));
}

function render(root: HTMLElement, c: Corpus): void {
  const again = () => render(root, c);
  const search = h('input', { type: 'search', class: 'ref-search', placeholder: 'Номер или слова: 9.10, обгон, 12.15', value: refState.query, 'aria-label': 'Поиск по нормам' });
  let timer = 0;
  search.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      refState.query = search.value;
      refState.limit = 60;
      refState.focus = '';
      renderList();
    }, 180);
  });
  const tabs = h('div', { class: 'ref-tabs' }, ...TABS.map(([t, label]) => h('button', { type: 'button', class: `pchip${refState.tab === t ? ' on' : ''}`, onclick: () => ((refState.tab = t), (refState.limit = 60), (refState.focus = ''), again()) }, label)));
  const list = h('div', { class: 'ref-list' });
  const foot = h('p', { class: 'disclaimer' }, `Источник: КонсультантПлюс (ПДД, КоАП РФ гл. 12, УК РФ гл. 27); изображения знаков — Wikimedia Commons (лицензии в public/signs/SOURCES.json) и собственная отрисовка; разметка — собственная отрисовка (public/markings/SOURCES.json). Загружено ${c.pdd.fetched}. Перед практическим применением сверяйте с действующей редакцией.`);
  root.replaceChildren(h('div', { class: 'ref-head' }, search, tabs), list, foot);

  function more(shown: number, total: number): HTMLElement | null {
    if (shown >= total) return null;
    return h('button', { type: 'button', class: 'btn', onclick: () => ((refState.limit += 60), renderList()) }, `Показать ещё (${total - shown})`);
  }

  function finish(items: HTMLElement[], total: number): void {
    list.replaceChildren(...(items.length ? items : [h('p', { class: 'note' }, 'Ничего не найдено. Попробуйте номер пункта или другое слово.')]));
    const m = more(items.length, total);
    if (m) list.append(m);
    const f = list.querySelector<HTMLElement>('[data-focus="1"]');
    if (f) f.scrollIntoView({ block: 'center' });
  }

  function renderList(): void {
    switch (refState.tab) {
      case 'pdd':
        return pdd();
      case 'signs':
        return signs();
      case 'markings':
        return markings();
      default:
        return code(refState.tab);
    }
  }

  function pointItem(id: string, label: string, text: string, sub?: string): HTMLElement {
    const focus = refState.focus === id;
    const first = text.split('\n')[0];
    return h('details', { class: 'ref-item', open: focus || undefined, 'data-focus': focus ? '1' : undefined },
      h('summary', {}, h('b', {}, label), ' ', first.length > 110 ? first.slice(0, 108) + '…' : first, sub ? h('small', {}, sub) : null),
      h('div', { class: 'ref-text' }, ...paragraphs(text)),
    );
  }

  function pdd(): void {
    const q = refState.query.trim();
    const flat: { id: string; label: string; text: string; sub: string }[] = [];
    for (const s of c.pdd.sections) for (const p of s.points) flat.push({ id: p.id, label: `п. ${p.id}`, text: p.text, sub: `Раздел ${s.id}. ${s.title}` });
    for (const p of c.pdd.basics?.points ?? []) flat.push({ id: `op:${p.id}`, label: `ОП ${p.id}`, text: p.text, sub: 'Основные положения по допуску ТС к эксплуатации' });
    for (const f of c.pdd.faults) for (const p of f.items) flat.push({ id: `fault:${p.id}`, label: `Неисправность ${p.id}`, text: p.text, sub: `Перечень неисправностей: ${f.title}` });
    if (!q) {
      const items: HTMLElement[] = [];
      for (const s of c.pdd.sections) {
        const open = refState.focus && s.points.some((p) => p.id === refState.focus);
        items.push(h('details', { class: 'ref-group', open: open || undefined }, h('summary', {}, `${s.id}. ${s.title}`, h('small', {}, `${s.points.length} п.`)), ...s.points.map((p) => pointItem(p.id, `п. ${p.id}`, p.text))));
      }
      items.push(h('details', { class: 'ref-group' }, h('summary', {}, 'Основные положения по допуску ТС к эксплуатации'), ...(c.pdd.basics?.points ?? []).map((p) => pointItem(`op:${p.id}`, `ОП ${p.id}`, p.text))));
      items.push(h('details', { class: 'ref-group' }, h('summary', {}, 'Перечень неисправностей и условий, при которых запрещается эксплуатация'), ...c.pdd.faults.map((f) => h('details', { class: 'ref-item' }, h('summary', {}, h('b', {}, f.id + '.'), ' ', f.title), h('div', { class: 'ref-text' }, ...f.items.map((p) => h('p', {}, `${p.id}. ${p.text}`)))))));
      list.replaceChildren(...items);
      const f = list.querySelector<HTMLElement>('[data-focus="1"]');
      if (f) f.scrollIntoView({ block: 'center' });
      return;
    }
    const hit = flat.filter((x) => matches(q, x.id, x.text, x.sub)).sort((a, b) => rank(q, a.id) - rank(q, b.id));
    finish(hit.slice(0, refState.limit).map((x) => pointItem(x.id, x.label, x.text, x.sub)), hit.length);
  }

  function signRow(it: SignItem, folder: string): HTMLElement {
    const focus = refState.focus === it.id;
    const imgs = it.imgs ?? (it.img ? [it.img] : []);
    return h('details', { class: 'ref-item sign', open: focus || undefined, 'data-focus': focus ? '1' : undefined },
      h('summary', {},
        imgs.length ? h('img', { src: imgUrl(imgs[0]), alt: '', loading: 'lazy', class: 'sign-thumb' }) : h('span', { class: 'sign-thumb ph' }),
        h('b', {}, `${folder} ${it.id}`),
        ' ',
        it.title || it.text.slice(0, 80),
      ),
      h('div', { class: 'ref-text' }, ...imgs.map((s) => h('img', { src: imgUrl(s), alt: it.title, class: 'sign-big' })), ...paragraphs(it.text)),
    );
  }

  function signs(): void {
    const q = refState.query.trim();
    if (!q) {
      list.replaceChildren(
        ...c.signs.groups.map((g) =>
          h('details', { class: 'ref-group', open: !!refState.focus && g.signs.some((s) => s.id === refState.focus) || undefined },
            h('summary', {}, `${g.id}. ${g.title}`, h('small', {}, `${g.signs.length}`)),
            g.intro ? h('p', { class: 'note' }, g.intro) : null,
            ...g.signs.map((s) => signRow(s, 'знак')),
            ...(g.notes.length ? [h('details', { class: 'ref-item' }, h('summary', {}, 'Правила применения и зона действия'), h('div', { class: 'ref-text' }, ...g.notes.map((n) => h('p', {}, n))))] : []),
          ),
        ),
      );
      const f = list.querySelector<HTMLElement>('[data-focus="1"]');
      if (f) f.scrollIntoView({ block: 'center' });
      return;
    }
    const hit = c.signs.groups.flatMap((g) => g.signs).filter((s) => matches(q, s.id, s.title, s.text)).sort((a, b) => rank(q, a.id) - rank(q, b.id));
    finish(hit.slice(0, refState.limit).map((s) => signRow(s, 'знак')), hit.length);
  }

  function markings(): void {
    const q = refState.query.trim();
    const sets = [c.markings.horizontal, c.markings.vertical].filter((x): x is NonNullable<typeof x> => !!x);
    const all = sets.flatMap((s) => s.items.map((it) => ({ it, set: s })));
    const hit = all.filter((x) => matches(q, x.it.id, x.it.title, x.it.text)).sort((a, b) => rank(q, a.it.id) - rank(q, b.it.id));
    const notes = !q ? sets.map((s) => h('details', { class: 'ref-group' }, h('summary', {}, s.title), h('div', { class: 'ref-text' }, ...s.notes.map((n) => h('p', {}, n))))) : [];
    finish([...notes, ...hit.slice(0, refState.limit).map((x) => signRow(x.it, 'разметка'))], hit.length);
  }

  function articleItem(a: Article, label: string): HTMLElement {
    const focus = refState.focus === a.id;
    return h('details', { class: 'ref-item', open: focus || undefined, 'data-focus': focus ? '1' : undefined },
      h('summary', {}, h('b', {}, `Статья ${a.id}.`), ' ', a.title, a.repealed ? h('small', {}, 'утратила силу') : null),
      h('div', { class: 'ref-text' },
        ...a.intro.filter((x) => !/^(КоАП|УК) РФ Статья/.test(x)).map((x) => h('p', {}, x)),
        ...a.parts.map((p) => h('div', { class: 'part' }, p.n ? h('b', {}, `${p.n}. `) : null, ...paragraphs(p.text))),
        ...a.notes.map((n) => h('p', { class: 'note' }, n)),
        h('small', {}, label),
      ),
    );
  }

  function code(tab: RefTab): void {
    const data = tab === 'koap' ? c.koap : c.uk;
    const q = refState.query.trim();
    const hit = data.articles
      .filter((a) => matches(q, a.id, a.title, ...a.parts.map((p) => p.text), ...a.notes))
      .sort((a, b) => rank(q, a.id) - rank(q, b.id));
    const head = !q ? [h('p', { class: 'note' }, data.chapter)] : [];
    finish([...head, ...hit.slice(0, refState.limit).map((a) => articleItem(a, data.code))], hit.length);
  }

  renderList();
}

/** Открыть конкретную норму: переключает вкладку, подставляет запрос и раскрывает пункт. */
export async function focusRef(id: string): Promise<void> {
  const c = await loadCorpus();
  const r = resolveRef(c, id);
  if (!r) return;
  refState.tab = r.where.tab;
  refState.query = '';
  refState.focus = r.where.query;
  refState.limit = 60;
}
