#!/usr/bin/env python3
"""Собирает src/data/*.json из страниц КонсультантПлюс (см. fetch-law.py) и картинок знаков (extract-signs.py).

Использование: python3 tools/build-law.py <каталог-кэша>
Результат: src/data/pdd.json, signs.json, markings.json, koap.json, uk.json
"""
import argparse
import json
import re
from datetime import date
from pathlib import Path

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('cache', type=Path)
parser.add_argument('--out', type=Path, default=ROOT / 'src' / 'data')
args = parser.parse_args()
OUT = args.out
cache = args.cache

NUM = r'\d+(?:\.\d+)*'


def load(doc: str):
    base = cache / doc
    directories = ([base] if (base / 'index.json').exists() else []) + sorted(
        d for d in base.iterdir() if d.is_dir() and (d / 'index.json').exists()
    )
    directories.sort(key=lambda d: json.loads((d / 'snapshot.json').read_text()).get('revisionDate') or '' if (d / 'snapshot.json').exists() else '')
    for directory in directories:
        metadata_file = directory / 'snapshot.json'
        metadata = json.loads(metadata_file.read_text()) if metadata_file.exists() else {
            'legalCheck': 'TODO(legal-check): кэш без даты и URL редакции; повторите fetch-law.py'
        }
        idx = json.loads((directory / 'index.json').read_text(encoding='utf-8'))
        for e in idx:
            f = directory / f"{e['hash']}.html"
            if not f.exists():
                raise ValueError(f'Неполный кэш: {f}')
            yield {**e, 'snapshot': metadata}, BeautifulSoup(f.read_text(encoding='utf-8'), 'lxml')


def version(e, text):
    meta = e['snapshot']
    if not meta.get('revisionDate') or not meta.get('validFrom'):
        return {'text': text, 'revisions': [], 'legalCheck': meta.get('legalCheck', 'TODO(legal-check): нет срока действия')}
    for key in ('revisionDate', 'validFrom', 'validTo'):
        if meta.get(key):
            date.fromisoformat(meta[key])
    if meta.get('validTo') and meta['validTo'] <= meta['validFrom']:
        raise ValueError('Пустой или обратный интервал редакции')
    revision = {
        'validFrom': meta['validFrom'], 'text': text,
        'source': {'url': e.get('url') or meta['url'], 'docTitle': meta['docTitle'], 'revisionDate': meta['revisionDate']},
    }
    if meta.get('validTo'):
        revision['validTo'] = meta['validTo']
    if meta.get('legalCheck'):
        revision['legalCheck'] = meta['legalCheck']
    if meta.get('effectiveSource'):
        revision['effectiveSource'] = meta['effectiveSource']
    sanction = sanction_of(text)
    if sanction:
        revision['sanction'] = sanction
    return {'text': text, 'revisions': [revision]}


def sanction_of(text):
    body = re.split(r'\n\d+(?:\s*[-–]\s*\d+)?\.\s*Утратил', text)[0]
    match = re.search(r'(?:^|\n|\s)(?:-|—)?\s*\n?((?:влеч[её]т|наказывается|наказываются)[\s\S]*)$', body)
    return match[1].replace('\n', ' ').strip() if match else None


def version_points(e, points):
    return [{**point, **version(e, point['text'])} for point in points]


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
        pdd['sections'].append({'id': m.group(1), 'title': m.group(2), 'points': version_points(e, parse_points(ps))})
    elif t.startswith('Основные положения'):
        pts = []
        for p in ps:
            mm = re.match(rf'^({NUM})\.?\s+(.*)$', p)
            if mm and not re.match(r'^\d{4}', mm.group(1)):
                pts.append({'id': mm.group(1), 'lines': [mm.group(2)]})
            elif pts:
                pts[-1]['lines'].append(p)
        previous_basics = pdd['basics']
        pdd['basics'] = {'title': 'Основные положения по допуску транспортных средств к эксплуатации и обязанности должностных лиц по обеспечению безопасности дорожного движения', 'points': version_points(e, [{'id': q['id'], 'text': tidy('\n'.join(q['lines']))} for q in pts])}
        if previous_basics:
            pdd['basics']['points'] = previous_basics['points'] + pdd['basics']['points']
    elif any(w in t for w in ('Тормозные', 'Рулевое', 'Устройства освещения', 'Обзорность', 'Колеса', 'Сцепные', 'Удерживающие', 'Двигатель', 'Прочие элементы', 'Комплектность')):
        mm = re.match(r'^(\d+)\.\s+(.*)$', t)
        pdd['faults'].append({'id': mm.group(1), 'title': mm.group(2), 'items': version_points(e, parse_points(ps) or [{'id': mm.group(1), 'text': tidy('\n'.join(ps))}])})
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
        items = version_points(e, items)
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
        items = version_points(e, items)
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
        markings[kind] = {'title': t, 'items': (markings[kind]['items'] if markings[kind] else []) + items, 'notes': notes}
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
            # «2 - 3. Утратили силу» — отдельные части, а не продолжение
            # диспозиции/санкции предыдущей действующей части.
            repealed_range = re.match(r'^(\d+)\s*[-–]\s*(\d+)\.\s*(Утратили силу.*)$', p)
            if repealed_range:
                parts.extend({'n': str(n), 'lines': [repealed_range[3]]}
                    for n in range(int(repealed_range[1]), int(repealed_range[2]) + 1))
                continue
            pm = PART.match(p)
            if pm:
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
            'parts': [{'n': q['n'], **version(e, tidy('\n'.join(q['lines'])))} for q in parts],
            'notes': notes,
        })
    arts.sort(key=lambda a: [int(x) for x in a['id'].split('.')])
    return arts


koap = {'code': 'КоАП РФ', 'chapter': 'Глава 12. Административные правонарушения в области дорожного движения', 'articles': parse_articles('koap', 'КоАП')}
uk = {'code': 'УК РФ', 'chapter': 'Глава 27. Преступления против безопасности движения и эксплуатации транспорта', 'articles': parse_articles('uk', 'УК')}

# Объединяем снимки по идентификаторам. Одинаковый validFrom с разным
# содержимым — ошибка; молчаливое затирание доказательств недопустимо.
def merge_nodes(nodes, key, children=None):
    result = {}
    for node in nodes:
        ident = node[key]
        if ident not in result:
            result[ident] = node
            continue
        old = result[ident]
        if children:
            node[children] = merge_nodes(old[children] + node[children], 'n' if children == 'parts' else 'id')
        elif 'revisions' in node:
            by_start = {r['validFrom']: r for r in old['revisions']}
            for revision in node['revisions']:
                start = revision['validFrom']
                if start in by_start and by_start[start] != revision:
                    raise ValueError(f'Конфликт редакций {ident}: {start}')
                by_start[start] = revision
            node['revisions'] = sorted(by_start.values(), key=lambda r: r['validFrom'])
            for left, right in zip(node['revisions'], node['revisions'][1:]):
                if not left.get('validTo') or left['validTo'] > right['validFrom']:
                    raise ValueError(f'Пересечение редакций {ident}; задайте validTo исторического снимка в манифесте')
            if node['revisions']:
                node['text'] = node['revisions'][-1]['text']
        result[ident] = node
    return list(result.values())

if pdd['basics']:
    pdd['basics']['points'] = merge_nodes(pdd['basics']['points'], 'id')
for kind in ('horizontal', 'vertical'):
    if markings[kind]:
        markings[kind]['items'] = merge_nodes(markings[kind]['items'], 'id')
pdd['sections'] = merge_nodes(pdd['sections'], 'id', 'points')
pdd['faults'] = merge_nodes(pdd['faults'], 'id', 'items')
signs['groups'] = merge_nodes(signs['groups'], 'id', 'signs')
for data in (koap, uk):
    data['articles'] = merge_nodes(data['articles'], 'id', 'parts')

# лёгкие индексы для редактора: номер -> [название, картинка]; корпус целиком грузится только в справочнике
sign_index = {s['id']: [s['title'] or s['text'][:60], s.get('img', '')] for g in signs['groups'] for s in g['signs']}
marking_index = {s['id']: [s['title'] or re.sub(r'^[\d.]+\s*(<\*>)?\s*(\([^)]*\))?\s*-\s*', '', s['text'].split('\n')[0])[:90], s.get('img', '')] for k in ('horizontal', 'vertical') if markings[k] for s in markings[k]['items']}

stamp = date.today().isoformat()
meta = {
    'fetched': stamp,
    'sources': {
        'pdd': 'КонсультантПлюс, ПДД (последняя редакция, cons_doc_LAW_2709); изображения знаков и разметки — PDF «ПДД 2026 от pddmaster.ru» (редакция от 01.09.2025)',
        'koap': 'КонсультантПлюс, КоАП РФ (cons_doc_LAW_34661), глава 12',
        'uk': 'КонсультантПлюс, УК РФ (cons_doc_LAW_10699), глава 27',
    },
}
OUT.mkdir(parents=True, exist_ok=True)
provenance = [json.loads(path.read_text()) for path in sorted(cache.glob('**/snapshot.json'))]
(OUT / 'law-sources.json').write_text(json.dumps(provenance, ensure_ascii=False, indent=2), encoding='utf-8')
for name, data in (('sign-index', sign_index), ('marking-index', marking_index), ('pdd', {**meta, **pdd}), ('signs', {**meta, **signs}), ('markings', {**meta, **markings}), ('koap', {**meta, **koap}), ('uk', {**meta, **uk})):
    (OUT / f'{name}.json').write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')

n_pts = sum(len(s['points']) for s in pdd['sections'])
print('ПДД: разделов', len(pdd['sections']), 'пунктов', n_pts, '| ОП', len(pdd['basics']['points']) if pdd['basics'] else 0, '| неисправности', sum(len(f['items']) for f in pdd['faults']))
print('знаки:', sum(len(g['signs']) for g in signs['groups']), 'с картинкой', sum(1 for g in signs['groups'] for s in g['signs'] if 'img' in s))
print('разметка:', {k: len(v['items']) if v else 0 for k, v in markings.items()})
print('КоАП статей', len(koap['articles']), 'частей', sum(len(a['parts']) for a in koap['articles']), '| УК статей', len(uk['articles']), 'частей', sum(len(a['parts']) for a in uk['articles']))
