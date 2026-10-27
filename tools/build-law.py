#!/usr/bin/env python3
"""Собирает src/data/*.json из текстов официального портала правовой информации (см. fetch-law.py).

Использование: python3 -I tools/build-law.py <каталог-кэша>
Результат: src/data/pdd.json, signs.json, markings.json, koap.json, uk.json, sign-index.json, marking-index.json

Из текста убираются примечания портала об изменениях («(В редакции …)», «(Дополнение …)»):
они не часть нормы. Если от части или пункта осталась только такая пометка
(«Часть утратила силу …»), она сохраняется как текст.
Картинки: знаки — public/signs/<номер>.svg (tools/build-signs.py, fetch-signs-commons.py),
разметка — public/markings/<номер>.svg (tools/build-markings.py).
"""
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'src' / 'data'
cache = Path(sys.argv[1])
meta_in = json.loads((cache / 'meta.json').read_text(encoding='utf-8'))

NUM = r'\d+(?:\.\d+)*'
SUP_OPEN, SUP_CLOSE = '\x01', '\x02'


class Paras(HTMLParser):
    """Абзацы <p> с классом; пометки об изменениях (span.mark) отделены от текста нормы."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out: list[dict] = []
        self.cur: dict | None = None
        self.stack: list[str] = []
        self.mark = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'p':
            self.cur = {'cls': a.get('class') or '', 'text': '', 'mark': ''}
            self.stack, self.mark = [], 0
        elif self.cur is None:
            return
        elif tag == 'span':
            c = a.get('class') or ''
            self.stack.append(c)
            if c in ('mark', 'markx'):
                self.mark += 1
            elif c == 'W9':
                self._put(SUP_OPEN)
        elif tag == 'br':
            self._put('\n')

    def handle_endtag(self, tag):
        if self.cur is None:
            return
        if tag == 'p':
            self.out.append(self.cur)
            self.cur = None
        elif tag == 'span' and self.stack:
            c = self.stack.pop()
            if c in ('mark', 'markx'):
                self.mark -= 1
            elif c == 'W9':
                self._put(SUP_CLOSE)

    def handle_data(self, data):
        if self.cur is not None:
            self._put(data)

    def _put(self, s):
        self.cur['mark' if self.mark else 'text'] += s


def paragraphs(key: str, sup: str) -> list[tuple[str, str]]:
    """(класс, текст). sup — как записывать верхний индекс: '({})' для ПДД, '.{}' для кодексов."""
    html = (cache / f'{key}.html').read_text(encoding='utf-8')
    p = Paras()
    p.feed(html[html.find('<body'):])
    out = []
    for q in p.out:
        text = re.sub(SUP_OPEN + r'\s*([^' + SUP_CLOSE + r']*?)\s*' + SUP_CLOSE, lambda m: sup.format(m.group(1)) if m.group(1) else '', q['text'])
        text = re.sub(r'[ \t\xa0]+', ' ', text.replace(SUP_OPEN, '').replace(SUP_CLOSE, ''))
        text = '\n'.join(x.strip() for x in text.split('\n') if x.strip())
        mark = re.sub(r'\s+', ' ', q['mark'].replace(SUP_OPEN, '').replace(SUP_CLOSE, '')).strip()
        # от нормы осталась только нумерация: «1. (Часть утратила силу - …)»
        if re.fullmatch(rf'(?:{NUM}(?:\(\d+\))?\.?|Статья {NUM}\.)?', text) and re.search(r'[Уу]трати|[Ии]сключ', mark):
            text = (text + ' ' + mark.strip('() ').replace(' - ', ' — ')).strip()
        # знаки сносок («переходу*», «1.1*»); сами сноски — абзацы класса N, начинаются со «*»
        if q['cls'] != 'N':
            text = re.sub(r'(?<=\S)\*+', '', text)
        # «абзац. (Утратил силу - …» → «абзац утратил силу — …»
        text = re.sub(r'([Аа]бзац|[Пп]римечание)[.;]?\s*\((Утратил|Исключен)([^)\n]*)\)?',
                      lambda m: f'{m.group(1)} {m.group(2).lower()}{m.group(3).replace(" - ", " — ")}', text)
        if text:
            out.append((q['cls'], text))
    return out


def tidy(t: str) -> str:
    t = re.sub(r'[ \t]+([,.;:)])', r'\1', t)
    t = re.sub(r'\(\s+', '(', t)
    return t.strip()


def sentence_case(t: str) -> str:
    """«ОБЩИЕ ПОЛОЖЕНИЯ» → «Общие положения»; смешанный регистр не трогаем."""
    return t[:1] + t[1:].lower() if t.isupper() else t


def pages(paras: list[tuple[str, str]], start: int, end: int, heading) -> list[tuple[str, list[str]]]:
    """Режет абзацы [start, end) на страницы по заголовкам; сноски (класс N) отбрасываются."""
    out: list[tuple[str, list[str]]] = []
    for cls, text in paras[start:end]:
        if heading(cls, text.replace('\n', ' ')):
            out.append((text.replace('\n', ' '), []))
        elif out and cls != 'N' and not re.fullmatch(r'_+', text):
            out[-1][1].append(text)
    return out


def index_of(paras, pred, frm=0) -> int:
    for n in range(frm, len(paras)):
        if pred(paras[n][0], paras[n][1].replace('\n', ' ')):
            return n
    sys.exit('не найден ожидаемый раздел документа — проверьте структуру текста на портале')


# ---------------------------------------------------------------- ПДД

P = paragraphs('pdd', '({})')
i_rules = index_of(P, lambda c, t: c == 'C' and t.startswith('1. ОБЩИЕ ПОЛОЖЕНИЯ'))
i_app1 = index_of(P, lambda c, t: c == 'S' and t.startswith('ПРИЛОЖЕНИЕ № 1'), i_rules)
i_app2 = index_of(P, lambda c, t: c == 'S' and t.startswith('ПРИЛОЖЕНИЕ № 2'), i_app1)
i_app3 = index_of(P, lambda c, t: c == 'S' and t.startswith('ПРИЛОЖЕНИЕ № 3'), i_app2)
i_basics = index_of(P, lambda c, t: c == 'T' and t.startswith('ОСНОВНЫЕ ПОЛОЖЕНИЯ'), i_app3)
i_faults = index_of(P, lambda c, t: c == 'T' and t.startswith('ПЕРЕЧЕНЬ неисправностей'), i_basics)
numbered = lambda c, t: c == 'C' and re.match(r'^\d+\.\s+\S', t) is not None

pdd = {'sections': [], 'basics': None, 'faults': [], 'notes': []}
POINT = re.compile(rf'^({NUM}(?:\(\d+\))?)\.\s+(.*)$', re.S)


def parse_points(ps: list[str]) -> list[dict]:
    pts: list[dict] = []
    for p in ps:
        m = POINT.match(p)
        if m and re.match(r'^\d+\.\d+', m.group(1)):
            pts.append({'id': m.group(1), 'lines': [m.group(2)]})
        elif pts:
            pts[-1]['lines'].append(p)
    return [{'id': q['id'], 'text': tidy('\n'.join(q['lines']))} for q in pts]


for title, ps in pages(P, i_rules, i_app1, lambda c, t: numbered(c, t) or (c == 'C' and t in ('Регулируемые перекрестки', 'Нерегулируемые перекрестки'))):
    m = re.match(r'^(\d+)\.\s+(.*)$', title)
    if m:
        pdd['sections'].append({'id': m.group(1), 'title': sentence_case(m.group(2)), 'points': parse_points(ps)})
    else:  # подзаголовок внутри раздела 13 — продолжение того же раздела
        pdd['sections'][-1]['points'] += parse_points(ps)

basics = []
for _, text in P[i_basics + 1:i_faults]:
    # «4(1).» — пункт 4 с верхним индексом 1; в корпусе такие пункты Основных положений нумеруются «4.1»
    text = re.sub(r'^(\d+)\((\d+)\)', r'\1.\2', text)
    mm = re.match(rf'^({NUM})\.?\s+(.*)$', text, re.S)
    if mm and not re.match(r'^\d{4}', mm.group(1)):
        basics.append({'id': mm.group(1), 'lines': [mm.group(2)]})
    elif basics and not re.fullmatch(r'_+', text) and not text.startswith('ПРИЛОЖЕНИЕ'):
        basics[-1]['lines'].append(text)
pdd['basics'] = {'title': 'Основные положения по допуску транспортных средств к эксплуатации и обязанности должностных лиц по обеспечению безопасности дорожного движения',
                 'points': [{'id': q['id'], 'text': tidy('\n'.join(q['lines']))} for q in basics]}

for title, ps in pages(P, i_faults + 1, len(P), numbered):
    mm = re.match(r'^(\d+)\.\s+(.*)$', title)
    pdd['faults'].append({'id': mm.group(1), 'title': mm.group(2), 'items': parse_points(ps) or [{'id': mm.group(1), 'text': tidy('\n'.join(ps))}]})

app3 = [t for c, t in P[i_app3 + 1:i_basics] if not re.fullmatch(r'_+', t) and c not in ('S', 'T')]
pdd['notes'].append({'title': 'Приложение № 3', 'text': '\n'.join(app3) or 'Утратило силу.'})

# ---------------------------------------------------------------- знаки и разметка

LEAD = re.compile(rf'^({NUM}(?:\s*[-–,]\s*{NUM})*)\s*(?:<\*>|\*)?\s*[-–]?\s*(.*)$', re.S)


def expand(s: str) -> list[str]:
    s = s.replace('–', '-')
    out: list[str] = []
    for part in [x.strip() for x in s.split(',')]:
        m = re.match(rf'^({NUM})\s*-\s*({NUM})$', part)
        if m:
            a, b = m.group(1).split('.'), m.group(2).split('.')
            if len(a) == len(b) and a[:-1] == b[:-1]:
                out += ['.'.join(a[:-1] + [str(n)]) for n in range(int(a[-1]), int(b[-1]) + 1)]
                continue
            out += [m.group(1), m.group(2)]
        elif re.fullmatch(NUM, part):
            out.append(part)
    return out


def items_from(ps: list[str], kind: str) -> tuple[list[dict], list[str]]:
    items, notes = [], []
    for p in ps:
        m = LEAD.match(p)
        # подпись знака: «1.1 "Название"» или для разметки «1.1 - описание»
        if m and (kind == 'marking' or '"' in m.group(2)[:140] or re.match(r'^\s*$', m.group(2))):
            ids = expand(m.group(1))
            if ids and not re.match(r'^\d{3,}', m.group(1)):
                rest = m.group(2)
                # «1.3.1 "Однопутная...", 1.3.2 "Многопутная..."»: у каждого номера своё название;
                # названия ищем только в «шапке» абзаца — до первого «". »
                named: dict[str, str] = {}
                if kind == 'sign':
                    cut = p.find('". ')
                    head = p[: cut + 2] if cut > 0 else p
                    for pm in re.finditer(rf'({NUM})(?:\s*[-–]\s*({NUM}))?\s*\*?\s*"([^"]+)"', head):
                        for i in expand(pm.group(1) + (f' - {pm.group(2)}' if pm.group(2) else '')):
                            named.setdefault(i, pm.group(3))
                    ids = ids + [i for i in named if i not in ids]
                first = re.search(r'"([^"]+)"', rest)
                for i in ids:
                    title = named.get(i) or (first.group(1) if first and kind == 'sign' else '')
                    dup = next((o for o in items if o['id'] == i), None)
                    if dup:
                        dup['text'] += '\n' + tidy(p)  # то же обозначение описано ещё одним абзацем
                        if not dup['title'] and title:
                            dup['title'] = tidy(title)
                        continue
                    items.append({'id': i, 'title': tidy(title), 'text': tidy(p), 'group': len(ids)})
                continue
        if items and re.match(r'^[а-яa-z]', p) and len(p) < 400:
            items[-1]['text'] += '\n' + p
        else:
            notes.append(tidy(p))
    return items, notes


def previous_images() -> dict[str, dict]:
    """Картинки, уже назначенные build-signs.py и build-markings.py: корпус их не переназначает."""
    out: dict[str, dict] = {}
    if (OUT / 'signs.json').exists():
        for g in json.loads((OUT / 'signs.json').read_text(encoding='utf-8'))['groups']:
            for s in g['signs']:
                out[f'signs:{s["id"]}'] = {k: s[k] for k in ('img', 'imgs') if k in s}
    if (OUT / 'markings.json').exists():
        m = json.loads((OUT / 'markings.json').read_text(encoding='utf-8'))
        for kind in ('horizontal', 'vertical'):
            for s in (m.get(kind) or {}).get('items', []):
                out[f'{kind}:{s["id"]}'] = {k: s[k] for k in ('img', 'imgs') if k in s}
    return out


PREV_IMG = previous_images()


def with_img(items: list[dict], kind: str, folder: str) -> None:
    for it in items:
        prev = PREV_IMG.get(f'{kind}:{it["id"]}', {})
        if prev.get('img') and (ROOT / 'public' / prev['img']).exists():
            it.update(prev)
        elif (ROOT / 'public' / f'{folder}/{it["id"]}.svg').exists():
            it['img'] = f'{folder}/{it["id"]}.svg'


signs = {'groups': []}
for title, ps in pages(P, i_app1, i_app2, numbered):
    gm = re.match(r'^(\d+)\.\s+(.*)$', title)
    items, notes = items_from(ps, 'sign')
    with_img(items, 'signs', 'signs')
    footnotes = [t for c, t in P[i_app1:i_app2] if c == 'N' and t.startswith('*')]
    if gm.group(1) == '1':
        notes += [f.replace('*', '<*>', 1) for f in footnotes]
    signs['groups'].append({'id': gm.group(1), 'title': gm.group(2), 'intro': notes[0] if notes else '', 'signs': items, 'notes': notes[1:]})

markings = {'horizontal': None, 'vertical': None}
for title, ps in pages(P, i_app2, i_app3, numbered):
    kind = 'horizontal' if 'Горизонтальная' in title else 'vertical'
    items, notes = items_from(ps, 'marking')
    with_img(items, kind, 'markings')
    markings[kind] = {'title': title, 'items': items, 'notes': notes}

# ---------------------------------------------------------------- КоАП и УК

PART = re.compile(r'^(\d+(?:\.\d+)?)\.\s+(.*)$', re.S)
ARTICLE = re.compile(r'^Статья\s+(\d+(?:\.\d+)*)\.\s*(.*)$', re.S)


def parse_articles(key: str, first: str, chapter_end: str) -> list[dict]:
    paras = paragraphs(key, '.{}')
    i0 = index_of(paras, lambda c, t: c == 'H' and t.startswith(f'Статья {first}.'))
    i1 = index_of(paras, lambda c, t: c == 'H' and t.upper().startswith(chapter_end), i0)
    arts = []
    for title, ps in pages(paras, i0, i1, lambda c, t: c == 'H' and t.startswith('Статья ')):
        m = ARTICLE.match(title)
        parts, notes, intro, mode = [], [], [], 'body'
        for p in ps:
            if re.match(r'^Примечани', p):
                mode = 'notes'
            if mode == 'notes':
                notes.append(tidy(p))
                continue
            pm = PART.match(p)
            if pm and not re.match(r'^\d+\)', p):
                parts.append({'n': pm.group(1), 'lines': [pm.group(2)]})
            elif parts:
                parts[-1]['lines'].append(p)
            else:
                intro.append(tidy(p))
        art_title = m.group(2)
        # статья из одной нормы без нумерации частей (например, 12.18)
        if not parts and intro and not any(re.search(r'[Уу]трати', x) for x in intro):
            parts, intro = [{'n': '', 'lines': intro}], []
        repealed = not art_title or bool(re.search(r'[Уу]тратил[аи]? силу', art_title)) or (not parts and any(re.search(r'[Уу]трати', x) for x in intro))
        arts.append({
            'id': m.group(1),
            'title': tidy(art_title) or 'Утратила силу',
            'repealed': repealed,
            'intro': intro,
            'parts': [{'n': q['n'], 'text': tidy('\n'.join(q['lines']))} for q in parts],
            'notes': notes,
        })
    return arts


koap = {'code': 'КоАП РФ', 'chapter': 'Глава 12. Административные правонарушения в области дорожного движения', 'articles': parse_articles('koap', '12.1', 'ГЛАВА 13')}
uk = {'code': 'УК РФ', 'chapter': 'Глава 27. Преступления против безопасности движения и эксплуатации транспорта', 'articles': parse_articles('uk', '263', 'ГЛАВА 28')}

# лёгкие индексы для редактора: номер -> [название, картинка]; корпус целиком грузится только в справочнике
sign_index = {s['id']: [s['title'] or s['text'][:60], s.get('img', '')] for g in signs['groups'] for s in g['signs']}
marking_index = {s['id']: [s['title'] or re.sub(r'^[\d.]+\s*(<\*>|\*)?\s*(\([^)]*\))?\s*-\s*', '', s['text'].split('\n')[0])[:90], s.get('img', '')] for k in ('horizontal', 'vertical') if markings[k] for s in markings[k]['items']}

docs = meta_in['docs']
src = lambda k: f'{meta_in["source"]}: {docs[k]["title"]}, редакция {docs[k]["redactionCaption"]}'
meta = {
    'fetched': meta_in['fetched'],
    'sources': {
        'pdd': src('pdd') + '; изображения знаков — Wikimedia Commons (лицензии в public/signs/SOURCES.json) и собственная отрисовка; разметка — собственная отрисовка (public/markings/SOURCES.json)',
        'koap': src('koap') + ', глава 12',
        'uk': src('uk') + ', глава 27',
    },
    'editions': {k: {'date': v['redactionDate'], 'caption': v['redactionCaption'], 'url': v['url'], 'official': v['official'], 'upcoming': v['upcoming']} for k, v in docs.items()},
}
OUT.mkdir(parents=True, exist_ok=True)
for name, data in (('sign-index', sign_index), ('marking-index', marking_index), ('pdd', {**meta, **pdd}), ('signs', {**meta, **signs}), ('markings', {**meta, **markings}), ('koap', {**meta, **koap}), ('uk', {**meta, **uk})):
    (OUT / f'{name}.json').write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')

n_pts = sum(len(s['points']) for s in pdd['sections'])
print('ПДД: разделов', len(pdd['sections']), 'пунктов', n_pts, '| ОП', len(pdd['basics']['points']), '| неисправности', sum(len(f['items']) for f in pdd['faults']))
print('знаки:', sum(len(g['signs']) for g in signs['groups']), 'с картинкой', sum(1 for g in signs['groups'] for s in g['signs'] if 'img' in s))
print('разметка:', {k: len(v['items']) if v else 0 for k, v in markings.items()})
print('КоАП статей', len(koap['articles']), 'частей', sum(len(a['parts']) for a in koap['articles']), '| УК статей', len(uk['articles']), 'частей', sum(len(a['parts']) for a in uk['articles']))
