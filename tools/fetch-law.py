#!/usr/bin/env python3
"""Скачивает страницы КонсультантПлюс с текстами ПДД, КоАП (гл. 12) и УК (гл. 27).

Использование: python3 tools/fetch-law.py <каталог-кэша>
Дальше: python3 tools/build-law.py <каталог-кэша>
"""
import json
import re
import subprocess
import sys
import time
import argparse
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urljoin
from datetime import datetime
from pathlib import Path

from bs4 import BeautifulSoup

BASE = 'https://www.consultant.ru'
UA = 'Mozilla/5.0 (X11; Linux x86_64) Crashtest-law-fetch'

DOCS = {
    'pdd': {'id': '2709', 'pick': lambda t, i, n: True},
    'koap': {'id': '34661', 'pick': lambda t, i, n: bool(re.match(r'^Статья 12\.\d', t))},
    'uk': {'id': '10699', 'pick': lambda t, i, n: bool(re.match(r'^Статья (?:109|118|26[3-9]|27[01])\.', t))},
}


def cached_page(path: Path) -> bool:
    return path.exists() and path.stat().st_size > 2000 and 'document-page__content' in path.read_text(encoding='utf-8')


def get(url: str, out: Path, tries: int = 4) -> bool:
    for k in range(tries):
        temporary = out.with_suffix('.download')
        r = subprocess.run(['curl', '-sS', '-m', '60', '-A', UA, '-o', str(temporary), '-w', '%{http_code}', url], capture_output=True, text=True)
        if r.stdout.strip() == '200' and cached_page(temporary):
            temporary.replace(out)
            return True
        temporary.unlink(missing_ok=True)
        time.sleep(2 * (k + 1))
    return False


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('cache')
    parser.add_argument('--revisions', type=Path, help='JSON: список снимков {doc, url, revisionDate, validFrom?, validTo?, effectiveSource?}')
    parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args()
    if not 1 <= args.workers <= 8:
        parser.error('--workers должен быть от 1 до 8')
    cache = Path(args.cache)
    cache.mkdir(parents=True, exist_ok=True)
    snapshots = json.loads(args.revisions.read_text()) if args.revisions else [
        {'doc': key, 'url': f"{BASE}/document/cons_doc_LAW_{cfg['id']}/"} for key, cfg in DOCS.items()
    ]
    for snap in snapshots:
        if args.revisions and not snap.get('revisionDate'):
            parser.error('Для архивного снимка требуется revisionDate из источника')
        key = snap['doc']
        cfg = DOCS[key]
        # Исторические снимки хранятся независимо от текущего.
        d = cache / key / snap['revisionDate'] if args.revisions else cache / key
        d.mkdir(parents=True, exist_ok=True)
        root = d / 'root.html'
        if not cached_page(root) and not get(snap['url'], root):
            sys.exit(f'не удалось скачать оглавление {key}')
        soup = BeautifulSoup(root.read_text(encoding='utf-8'), 'lxml')
        title = soup.find('h1')
        title = title.get_text(' ', strip=True) if title else ''
        match = re.search(r'ред\. от (\d{2}\.\d{2}\.\d{4})', title)
        revision_date = datetime.strptime(match[1], '%d.%m.%Y').date().isoformat() if match else None
        if snap.get('revisionDate') and snap['revisionDate'] != revision_date:
            sys.exit(f"Дата источника не совпадает с манифестом: {snap['url']}")
        metadata = {**snap, 'revisionDate': revision_date, 'docTitle': title}
        if not revision_date:
            metadata['legalCheck'] = 'TODO(legal-check): источник не содержит даты редакции'
        elif not snap.get('effectiveSource'):
            metadata['validFrom'] = revision_date
            metadata['legalCheck'] = 'TODO(legal-check): начало интервала взято из даты редакции документа; вступление изменений в силу и полнота истории не подтверждены'
        elif not snap.get('validFrom'):
            sys.exit('effectiveSource требует явного validFrom, проверенного по изменяющему акту')
        # В ПДД список изменяющих документов содержит постановления Правительства.
        # Сохраняем ссылки для проверки сроков, не выводим сроки из даты принятия акта.
        content = soup.find(class_='document-page__content')
        metadata['editionNavigation'] = [a['data-document-link'] for a in soup.find_all('a', attrs={'data-document-link': True})
            if 'editions' in a['data-document-link']]
        metadata['amendments'] = [
            {'url': urljoin(snap['url'], a['href']), 'title': a.get_text(' ', strip=True)}
            for a in (content.find_all('a', href=True) if content else [])
            if '/document/' in a['href']
        ]
        (d / 'snapshot.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2))
        root_id = re.search(r'cons_doc_LAW_(\d+)', snap['url'])[1]
        links, seen = [], set()
        for a in soup.find_all('a', href=True):
            h = a['href']
            m = re.search(rf"cons_doc_LAW_{root_id}/([0-9a-f]{{40}})/", h)
            if not m or m.group(1) in seen:
                continue
            seen.add(m.group(1))
            links.append((m.group(1), a.get_text(' ', strip=True), urljoin(snap['url'], h).replace('http://www.consultant.ru/', 'https://www.consultant.ru/')))
        picked = [(h, t, u) for i, (h, t, u) in enumerate(links) if cfg['pick'](t, i, len(links))]
        if not picked:
            sys.exit(f'Нет страниц нужного документа в снимке: {snap["url"]}; проверьте URL редакции')
        (d / 'index.json').write_text(json.dumps([{'hash': h, 'title': t, 'url': u} for h, t, u in picked], ensure_ascii=False, indent=1), encoding='utf-8')
        print(key, len(picked), 'страниц')
        def fetch_page(entry):
            h, t, url = entry
            f = d / f'{h}.html'
            if not cached_page(f) and not get(url, f):
                raise RuntimeError(f'Не скачалось: {url} ({t})')
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            list(pool.map(fetch_page, picked))


if __name__ == '__main__':
    main()
