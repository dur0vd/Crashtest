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
from pathlib import Path

from bs4 import BeautifulSoup

BASE = 'https://www.consultant.ru'
UA = 'Mozilla/5.0 (X11; Linux x86_64) Crashtest-law-fetch'

DOCS = {
    'pdd': {'id': '2709', 'pick': lambda t, i, n: True},
    'koap': {'id': '34661', 'pick': lambda t, i, n: bool(re.match(r'^Статья 12\.\d', t))},
    'uk': {'id': '10699', 'pick': lambda t, i, n: bool(re.match(r'^Статья (?:109|118|26[3-9]|27[01])\.', t))},
}


def get(url: str, out: Path, tries: int = 4) -> bool:
    for k in range(tries):
        r = subprocess.run(['curl', '-sS', '-m', '60', '-A', UA, '-o', str(out), '-w', '%{http_code}', url], capture_output=True, text=True)
        if r.stdout.strip() == '200' and out.stat().st_size > 2000:
            return True
        time.sleep(2 * (k + 1))
    return False


def main() -> None:
    cache = Path(sys.argv[1])
    cache.mkdir(parents=True, exist_ok=True)
    for key, cfg in DOCS.items():
        d = cache / key
        d.mkdir(exist_ok=True)
        root = d / 'root.html'
        if not root.exists() and not get(f"{BASE}/document/cons_doc_LAW_{cfg['id']}/", root):
            sys.exit(f'не удалось скачать оглавление {key}')
        soup = BeautifulSoup(root.read_text(encoding='utf-8'), 'lxml')
        links, seen = [], set()
        for a in soup.find_all('a', href=True):
            h = a['href']
            m = re.search(rf"cons_doc_LAW_{cfg['id']}/([0-9a-f]{{40}})/", h)
            if not m or m.group(1) in seen:
                continue
            seen.add(m.group(1))
            links.append((m.group(1), a.get_text(' ', strip=True)))
        picked = [(h, t) for i, (h, t) in enumerate(links) if cfg['pick'](t, i, len(links))]
        (d / 'index.json').write_text(json.dumps([{'hash': h, 'title': t} for h, t in picked], ensure_ascii=False, indent=1), encoding='utf-8')
        print(key, len(picked), 'страниц')
        for h, t in picked:
            f = d / f'{h}.html'
            if f.exists():
                continue
            if not get(f"{BASE}/document/cons_doc_LAW_{cfg['id']}/{h}/", f):
                print('  не скачалось:', t[:60])
            time.sleep(0.6)


if __name__ == '__main__':
    main()
