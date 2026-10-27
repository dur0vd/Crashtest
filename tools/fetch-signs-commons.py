#!/usr/bin/env python3
"""Скачивает изображения знаков приложения 1 к ПДД с Wikimedia Commons с проверкой лицензии.

Запускать на своём компьютере (из облачных сессий Commons отвечает 429), из корня репозитория:

    python3 -I tools/fetch-signs-commons.py            # скачать недостающие знаки
    python3 -I tools/fetch-signs-commons.py --dry-run  # только показать, что будет найдено
    python3 -I tools/fetch-signs-commons.py --only 2.1,3.24 --force

Нужен только Python 3.9+ (без сторонних пакетов).

Что делает:
- для каждого знака из src/data/sign-index.json ищет SVG на Commons: сначала по типовым
  именам файлов, затем поиском по номеру знака;
- берёт файл только с лицензией PD, CC0, CC BY или CC BY-SA (по метаданным Commons);
- отбрасывает SVG со скриптами и внешними ссылками;
- кладёт файл в public/signs/<номер>.svg и записывает источник, лицензию, автора и
  атрибуцию в public/signs/SOURCES.json (запись начинается с «Wikimedia Commons», поэтому
  tools/build-signs.py её не перезапишет);
- собирает tools/out/signs-review.html — все знаки рядом с названиями для проверки глазами.

Знаки, для которых подходящий файл не найден, остаются заглушками. Найденное поиском
обязательно просмотрите в signs-review.html: поиск может вернуть похожий, но другой знак.
"""
import argparse
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SIGNS = os.path.join(ROOT, 'public/signs')
MANIFEST = os.path.join(SIGNS, 'SOURCES.json')
INDEX = os.path.join(ROOT, 'src/data/sign-index.json')
REVIEW = os.path.join(ROOT, 'tools/out/signs-review.html')

API = 'https://commons.wikimedia.org/w/api.php'
UA = 'CrashtestSignFetcher/1.0 (https://github.com/dur0vd/Crashtest; road-sign images for an educational app)'
PAUSE = 1.0
MAX_SVG = 600 * 1024

# Типовые имена файлов российских знаков на Commons; {id} — номер знака.
PATTERNS = [
    'RU road sign {id}.svg',
    '{id} Russian road sign.svg',
    'Russia road sign {id}.svg',
    'RU road sign {id} (2006).svg',
]


def request(params, tries=6):
    params = {**params, 'format': 'json', 'formatversion': '2', 'maxlag': '5'}
    url = API + '?' + urllib.parse.urlencode(params)
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=60) as r:
                data = json.load(r)
            if data.get('error', {}).get('code') == 'maxlag':
                time.sleep(5 * (k + 1))
                continue
            time.sleep(PAUSE)
            return data
        except urllib.error.HTTPError as e:
            if e.code in (429, 503):
                wait = int(e.headers.get('Retry-After') or 10 * (k + 1))
                print(f'  Commons просит подождать {wait} с…', file=sys.stderr)
                time.sleep(wait)
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            time.sleep(5 * (k + 1))
    sys.exit('Commons не отвечает, попробуйте позже')


def download(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read(MAX_SVG + 1)
    time.sleep(PAUSE)
    return body


def strip_tags(value):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', value or ''))).strip()


def license_of(meta):
    """Нормализованная строка лицензии или None, если лицензия не подходит."""
    code = (meta.get('License', {}).get('value') or '').lower()
    short = meta.get('LicenseShortName', {}).get('value') or ''
    if code.startswith('pd') or 'public domain' in short.lower():
        return f'PD ({short or code})'
    if code.startswith('cc0') or short.upper().startswith('CC0'):
        return 'CC0 1.0'
    m = re.match(r'cc-(by(?:-sa)?)-([\d.]+)', code)
    if m:
        return f'CC {m.group(1).upper()} {m.group(2)}'
    return None


def safe_svg(body):
    if len(body) > MAX_SVG:
        return 'файл больше 600 КБ'
    text = body.decode('utf-8', errors='replace')
    if '<svg' not in text[:2000].lower():
        return 'не SVG'
    low = text.lower()
    if '<script' in low or 'javascript:' in low or re.search(r'\son\w+\s*=', low):
        return 'в SVG есть скрипт'
    if re.search(r'(?:xlink:)?href\s*=\s*["\']https?:', low) or '<foreignobject' in low:
        return 'в SVG есть внешние ссылки'
    return None


def same_sign(title, sid):
    """Номер знака в имени файла как отдельный токен: 3.2 не совпадает с 3.24 или 3.2.1."""
    return re.search(r'(?<![\d.])' + re.escape(sid) + r'(?![\d]|\.\d)', title) is not None


def file_infos(titles):
    out = {}
    for n in range(0, len(titles), 40):
        data = request({
            'action': 'query', 'prop': 'imageinfo', 'iiprop': 'url|extmetadata|mime',
            'iiextmetadatafilter': 'LicenseShortName|License|Artist|AttributionRequired|Credit',
            'titles': '|'.join('File:' + t for t in titles[n:n + 40]),
        })
        norm = {x['to']: x['from'] for x in data.get('query', {}).get('normalized', [])}
        for page in data.get('query', {}).get('pages', []):
            if page.get('missing') or not page.get('imageinfo'):
                continue
            name = page['title'].split(':', 1)[1]
            out[norm.get(page['title'], page['title']).split(':', 1)[1]] = {'title': name, **page['imageinfo'][0]}
    return out


def search(sid):
    data = request({
        'action': 'query', 'list': 'search', 'srnamespace': '6', 'srlimit': '20',
        'srsearch': f'intitle:"{sid}" filetype:drawing Russia road sign',
    })
    titles = [r['title'].split(':', 1)[1] for r in data.get('query', {}).get('search', [])]
    good = [t for t in titles if t.lower().endswith('.svg') and same_sign(t, sid)
            and re.search(r'\b(RU|Russia|Russian|Россия)\b', t, re.I)]
    return good


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true', help='ничего не записывать')
    ap.add_argument('--only', help='номера знаков через запятую')
    ap.add_argument('--force', action='store_true', help='заменить уже скачанные с Commons')
    ap.add_argument('--no-search', action='store_true', help='только типовые имена, без поиска')
    args = ap.parse_args()

    index = json.load(open(INDEX, encoding='utf-8'))
    manifest = json.load(open(MANIFEST, encoding='utf-8'))
    items = {i['file']: i for i in manifest['items']}
    ids = [s.strip() for s in args.only.split(',')] if args.only else list(index)
    todo = [sid for sid in ids if sid in index and (args.force or not items.get(index[sid][1], {}).get('source', '').startswith('Wikimedia'))]
    print(f'знаков к поиску: {len(todo)}')

    # 1. типовые имена — пакетными запросами
    wanted = {p.format(id=sid): sid for sid in todo for p in PATTERNS}
    infos = file_infos(list(wanted))
    found = {}
    for name, info in infos.items():
        sid = wanted[name]
        found.setdefault(sid, []).append(info)

    # 2. поиск для оставшихся
    if not args.no_search:
        rest = [sid for sid in todo if sid not in found]
        print(f'по типовым именам найдено: {len(found)}, ищем остальные: {len(rest)}')
        for n, sid in enumerate(rest, 1):
            titles = search(sid)
            if titles:
                for info in file_infos(titles[:5]).values():
                    info['by_search'] = True
                    found.setdefault(sid, []).append(info)
            if n % 20 == 0:
                print(f'  поиск: {n}/{len(rest)}')

    report = {'ok': [], 'license': [], 'unsafe': [], 'missing': []}
    for sid in todo:
        cands = found.get(sid, [])
        chosen, reason = None, None
        for info in cands:
            lic = license_of(info.get('extmetadata', {}))
            if not lic:
                reason = f'лицензия не подходит: {info["title"]}'
                continue
            if info.get('mime') != 'image/svg+xml':
                continue
            chosen = (info, lic)
            break
        if not chosen:
            report['license' if reason else 'missing'].append((sid, reason or ''))
            continue
        info, lic = chosen
        body = download(info['url'])
        bad = safe_svg(body)
        if bad:
            report['unsafe'].append((sid, f'{info["title"]}: {bad}'))
            continue
        meta = info.get('extmetadata', {})
        author = strip_tags(meta.get('Artist', {}).get('value')) or 'автор не указан'
        attribution = None
        if lic.startswith('CC BY'):
            attribution = f'{author}, «{info["title"]}», {lic}, Wikimedia Commons ({info["descriptionurl"]})'
        file_rel = index[sid][1]
        report['ok'].append((sid, info['title'] + (' — найден поиском, проверьте' if info.get('by_search') else '')))
        if args.dry_run:
            continue
        with open(os.path.join(ROOT, 'public', file_rel), 'wb') as f:
            f.write(body)
        items[file_rel] = {
            'file': file_rel,
            'ids': [sid],
            'source': f'Wikimedia Commons: {info["descriptionurl"]}',
            'license': lic,
            'author': author,
            'attribution': attribution,
            'status': 'Wikimedia Commons' + (' (найден поиском — сверить)' if info.get('by_search') else ''),
        }

    if not args.dry_run:
        external = [i for i in items.values() if i.get('source', '').startswith('Wikimedia')]
        own = [i for i in items.values() if not i.get('source', '').startswith('Wikimedia')]
        manifest['items'] = sorted(external, key=lambda i: i['file']) + own
        with open(MANIFEST, 'w', encoding='utf-8') as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
            f.write('\n')
        write_review(index, items)

    print(f'\nскачано: {len(report["ok"])}')
    for sid, note in report['ok']:
        if 'поиском' in note:
            print(f'  {sid}: {note}')
    for key, title in [('license', 'отклонено по лицензии'), ('unsafe', 'отклонено как небезопасное'), ('missing', 'не найдено (остаются заглушки)')]:
        if report[key]:
            print(f'{title}: {len(report[key])}')
            print('  ' + ', '.join(sid for sid, _ in report[key]))
    if not args.dry_run:
        print(f'\nПроверьте знаки глазами: {os.path.relpath(REVIEW, ROOT)}')
        print('Затем: python3 -I tools/build-signs.py && npm test')


def write_review(index, items):
    os.makedirs(os.path.dirname(REVIEW), exist_ok=True)
    cells = []
    for sid, (title, file_rel) in index.items():
        item = items.get(file_rel, {})
        status = item.get('status', '')
        warn = ' warn' if 'сверить' in status or status == 'заглушка' else ''
        cells.append(
            f'<figure class="c{warn}"><img src="../../public/{html.escape(file_rel)}" alt="">'
            f'<figcaption><b>{html.escape(sid)}</b> {html.escape(title)}<br><small>{html.escape(status)} · {html.escape(item.get("license", ""))}</small></figcaption></figure>')
    page = ('<!doctype html><meta charset="utf-8"><title>Знаки: проверка</title><style>'
            'body{font:14px system-ui;margin:16px}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px}'
            '.c{margin:0;border:1px solid #ccc;border-radius:8px;padding:8px;text-align:center}.warn{background:#fff4d6}'
            'img{height:90px;max-width:100%;object-fit:contain}</style>'
            '<h1>Знаки ПДД — проверка изображений</h1><p>Жёлтым — заглушки и файлы, найденные поиском: их нужно сверить с номером и названием.</p>'
            '<main>' + ''.join(cells) + '</main>')
    with open(REVIEW, 'w', encoding='utf-8') as f:
        f.write(page)


if __name__ == '__main__':
    main()
