#!/usr/bin/env python3
"""Собирает src/data/*.json из страниц КонсультантПлюс (см. fetch-law.py) и картинок знаков (extract-signs.py).

Использование: python3 tools/build-law.py <каталог-кэша>
Результат: src/data/pdd.json, signs.json, markings.json, koap.json, uk.json
"""
import json
import re
import sys
from datetime import date
from pathlib import Path

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'src' / 'data'
cache = Path(sys.argv[1])

NUM = r'\d+(?:\.\d+)*'


def load(doc: str):
    idx = json.loads((cache / doc / 'index.json').read_text(encoding='utf-8'))
    for e in idx:
        f = cache / doc / f"{e['hash']}.html"
        if f.exists():
            yield e, BeautifulSoup(f.read_text(encoding='utf-8'), 'lxml')


def paras(soup) -> list[str]:
    """Абзацы самого текста: без примечаний об изменениях и рекламных вставок КонсультантПлюс."""
    d = soup.find(class_='document-page__content')
    out = []
    for p in d.find_all('p'):
        if 'no-indent' in (p.get('class') or []):
            continue
        t = re.sub(r'\s+', ' ', p.get_text('').replace('\xa0', ' ')).strip()
        if t and not re.fullmatch(r'-{5,}', t):
            out.append(t)
    return out


def h1(soup) -> str:
    h = soup.find('h1')
    return re.sub(r'\s+', ' ', h.get_text(' ', strip=True)) if h else ''


def tidy(t: str) -> str:
    t = re.sub(r'\s+([,.;:)])', r'\1', t)
    t = re.sub(r'\(\s+', '(', t)
    return t.strip()


# ---------------------------------------------------------------- ПДД: главы

pdd = {'sections': [], 'basics': None, 'faults': [], 'notes': []}
POINT = re.compile(rf'^({NUM}(?:\(\d+\))?)\.\s+(.*)$')


def parse_points(ps: list[str], depth_min: int = 2) -> list[dict]:
    pts: list[dict] = []
    for p in ps:
        m = POINT.match(p)
        if m and re.match(r'^\d+\.\d+', m.group(1)):
            pts.append({'id': m.group(1), 'lines': [m.group(2)]})
        elif pts:
            pts[-1]['lines'].append(p)
        else:
            pts.append({'id': '', 'lines': [p]})
    return [{'id': q['id'], 'text': tidy('\n'.join(q['lines']))} for q in pts if q['id']]


for e, soup in load('pdd'):
    t = e['title']
    m = re.match(r'^(\d+)\.\s+(.*)$', t)
    ps = paras(soup)
    if m and not any(w in t for w in ('Тормозные', 'Рулевое', 'Устройства освещения', 'Обзорность', 'Колеса', 'Сцепные', 'Удерживающие', 'Двигатель', 'Прочие элементы', 'Комплектность', 'знаки', 'Знаки', 'разметка')):
        pdd['sections'].append({'id': m.group(1), 'title': m.group(2), 'points': parse_points(ps)})
    elif t.startswith('Основные положения'):
        pts = []
        for p in ps:
            mm = re.match(rf'^({NUM})\.?\s+(.*)$', p)
            if mm and not re.match(r'^\d{4}', mm.group(1)):
                pts.append({'id': mm.group(1), 'lines': [mm.group(2)]})
            elif pts:
                pts[-1]['lines'].append(p)
        pdd['basics'] = {'title': 'Основные положения по допуску транспортных средств к эксплуатации и обязанности должностных лиц по обеспечению безопасности дорожного движения', 'points': [{'id': q['id'], 'text': tidy('\n'.join(q['lines']))} for q in pts]}
    elif any(w in t for w in ('Тормозные', 'Рулевое', 'Устройства освещения', 'Обзорность', 'Колеса', 'Сцепные', 'Удерживающие', 'Двигатель', 'Прочие элементы', 'Комплектность')):
        mm = re.match(r'^(\d+)\.\s+(.*)$', t)
        pdd['faults'].append({'id': mm.group(1), 'title': mm.group(2), 'items': [{'id': q['id'], 'text': q['text']} for q in parse_points(ps)] or [{'id': mm.group(1), 'text': tidy('\n'.join(ps))}]})
    elif t.startswith('Приложение N 3'):
        pdd['notes'].append({'title': t, 'text': '\n'.join(ps)})

pdd['sections'].sort(key=lambda s: int(s['id']))
pdd['faults'].sort(key=lambda s: int(s['id']))

# ---------------------------------------------------------------- знаки и разметка

images = json.loads((ROOT / 'tools' / 'out' / 'sign-images.json').read_text(encoding='utf-8'))
LEAD = re.compile(rf'^({NUM}(?:\s*[-–,]\s*{NUM})*)\s*(?:<\*>)?\s*[-–]?\s*(.*)$', re.S)


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
        if m and (kind == 'marking' or '"' in m.group(2)[:140] or re.match(r'^\s*$', m.group(2))) and not p.startswith('<*>'):
            ids = expand(m.group(1))
            if ids and not re.match(r'^\d{3,}', m.group(1)):
                rest = m.group(2)
                # «1.3.1 "Однопутная...", 1.3.2 "Многопутная..."»: у каждого номера своё название;
                # названия ищем только в «шапке» абзаца — до первого «". »
                named: dict[str, str] = {}
                if kind == 'sign':
                    cut = p.find('". ')
                    head = p[: cut + 2] if cut > 0 else p
                    for pm in re.finditer(rf'({NUM})(?:\s*[-–]\s*({NUM}))?\s*"([^"]+)"', head):
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


signs = {'groups': []}
markings = {'horizontal': None, 'vertical': None}
for e, soup in load('pdd'):
    t = e['title']
    ps = paras(soup)
    mm = re.match(r'^(\d+)\.\s+(.*)$', t)
    if mm and any(w in t for w in ('знаки', 'Знаки')) and 'таблички' in t.lower() or (mm and t.split('. ', 1)[1] in ('Предупреждающие знаки', 'Знаки приоритета', 'Запрещающие знаки', 'Предписывающие знаки', 'Знаки особых предписаний', 'Информационные знаки', 'Знаки сервиса')):
        items, notes = items_from(ps, 'sign')
        for it in items:
            f = images.get(f"sign:{it['id']}")
            if f:
                it['img'] = f['files'][0]
                if len(f['files']) > 1:
                    it['imgs'] = f['files']
        for it in items:
            if 'img' not in it:
                sib = next((o for o in items if o is not it and o['text'] == it['text'] and 'img' in o), None)
                if sib:
                    it['img'] = sib['img']
        signs['groups'].append({'id': mm.group(1), 'title': mm.group(2), 'intro': notes[0] if notes else '', 'signs': items, 'notes': notes[1:]})
    elif t.endswith('Горизонтальная разметка') or t.endswith('Вертикальная разметка'):
        kind = 'horizontal' if 'Горизонтальная' in t else 'vertical'
        items, notes = items_from(ps, 'marking')
        for it in items:
            f = images.get(f"marking-{'h' if kind == 'horizontal' else 'v'}:{it['id']}")
            if f:
                it['img'] = f['files'][0]
                if len(f['files']) > 1:
                    it['imgs'] = f['files']
        # у знаков одной подписи («1.14.1, 1.14.2») картинка может быть общей
        for it in items:
            if 'img' not in it and it['group'] > 1:
                sib = next((o for o in items if o is not it and o['text'] == it['text'] and 'img' in o), None)
                if sib:
                    it['img'] = sib['img']
        markings[kind] = {'title': t, 'items': items, 'notes': notes}
signs['groups'].sort(key=lambda g: int(g['id']))

# ---------------------------------------------------------------- КоАП и УК

PART = re.compile(r'^(\d+(?:\.\d+)?)\.\s+(.*)$', re.S)


def parse_articles(doc: str, label: str) -> list[dict]:
    arts = []
    for e, soup in load(doc):
        m = re.match(r'^Статья\s+(\d+(?:\.\d+)*)\.\s*(.*)$', e['title'])
        if not m:
            continue
        ps = paras(soup)
        # первая строка страницы бывает заголовком статьи в тексте
        parts, notes, intro, mode = [], [], [], 'body'
        for p in ps:
            if re.match(r'^Примечани', p):
                mode = 'notes'
            if mode == 'notes':
                notes.append(tidy(p))
                continue
            pm = PART.match(p)
            if pm and (not parts or True) and not re.match(r'^\d+\)', p):
                parts.append({'n': pm.group(1), 'lines': [pm.group(2)]})
            elif parts:
                parts[-1]['lines'].append(p)
            else:
                intro.append(tidy(p))
        title = m.group(2)
        # статья из одной нормы без нумерации частей (например, 12.18)
        if not parts and intro and not any('Утратил' in x for x in intro):
            parts = [{'n': '', 'lines': [x for x in intro if not re.match(r'^(КоАП|УК) РФ Статья', x)]}]
            intro = []
        repealed = bool(re.search(r'Утратил[аи]? силу', title)) or (not parts and any('Утратил' in x for x in intro))
        arts.append({
            'id': m.group(1),
            'title': tidy(title),
            'repealed': repealed,
            'intro': intro,
            'parts': [{'n': q['n'], 'text': tidy('\n'.join(q['lines']))} for q in parts],
            'notes': notes,
        })
    arts.sort(key=lambda a: [int(x) for x in a['id'].split('.')])
    return arts


koap = {'code': 'КоАП РФ', 'chapter': 'Глава 12. Административные правонарушения в области дорожного движения', 'articles': parse_articles('koap', 'КоАП')}
uk = {'code': 'УК РФ', 'chapter': 'Глава 27 и статьи 109, 118 (ориентиры для немеханических ТС)', 'articles': parse_articles('uk', 'УК')}
# Ст. 109 и 118 нужны для ориентировочной оценки вреда от немеханических ТС.
# Старый кэш главы 27 нужно дополнить через обновлённый fetch-law.py.
missing_uk = {'109', '118'} - {a['id'] for a in uk['articles']}
if missing_uk:
    sys.exit('В кэше отсутствуют статьи УК ' + ', '.join(sorted(missing_uk))
             + '; запустите tools/fetch-law.py для обновления кэша')


# лёгкие индексы для редактора: номер -> [название, картинка]; корпус целиком грузится только в справочнике
sign_index = {s['id']: [s['title'] or s['text'][:60], s.get('img', '')] for g in signs['groups'] for s in g['signs']}
marking_index = {s['id']: [s['title'] or re.sub(r'^[\d.]+\s*(<\*>)?\s*(\([^)]*\))?\s*-\s*', '', s['text'].split('\n')[0])[:90], s.get('img', '')] for k in ('horizontal', 'vertical') if markings[k] for s in markings[k]['items']}

stamp = date.today().isoformat()
meta = {
    'fetched': stamp,
    'sources': {
        'pdd': 'КонсультантПлюс, ПДД (последняя редакция, cons_doc_LAW_2709); изображения знаков и разметки — PDF «ПДД 2026 от pddmaster.ru» (редакция от 01.09.2025)',
        'koap': 'КонсультантПлюс, КоАП РФ (cons_doc_LAW_34661), глава 12',
        'uk': 'КонсультантПлюс, УК РФ (cons_doc_LAW_10699), глава 27 и статьи 109, 118',
    },
}
OUT.mkdir(parents=True, exist_ok=True)
for name, data in (('sign-index', sign_index), ('marking-index', marking_index), ('pdd', {**meta, **pdd}), ('signs', {**meta, **signs}), ('markings', {**meta, **markings}), ('koap', {**meta, **koap}), ('uk', {**meta, **uk})):
    (OUT / f'{name}.json').write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')

n_pts = sum(len(s['points']) for s in pdd['sections'])
print('ПДД: разделов', len(pdd['sections']), 'пунктов', n_pts, '| ОП', len(pdd['basics']['points']) if pdd['basics'] else 0, '| неисправности', sum(len(f['items']) for f in pdd['faults']))
print('знаки:', sum(len(g['signs']) for g in signs['groups']), 'с картинкой', sum(1 for g in signs['groups'] for s in g['signs'] if 'img' in s))
print('разметка:', {k: len(v['items']) if v else 0 for k, v in markings.items()})
print('КоАП статей', len(koap['articles']), 'частей', sum(len(a['parts']) for a in koap['articles']), '| УК статей', len(uk['articles']), 'частей', sum(len(a['parts']) for a in uk['articles']))
