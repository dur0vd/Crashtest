#!/usr/bin/env python3
"""Скачивает актуальные редакции ПДД, КоАП и УК с официального портала правовой информации.

Источник: ИПС «Законодательство России», actual.pravo.gov.ru (тексты правовых актов
с внесёнными изменениями). Используется тот же API, что и у самого сайта.

Использование: python3 -I tools/fetch-law.py <каталог-кэша>
Дальше:        python3 -I tools/build-law.py <каталог-кэша>

В каталоге появятся pdd.html, koap.html, uk.html (текст редакции) и meta.json
(номер и дата редакции, документ, дата выгрузки). Кэш в репозиторий не кладётся.

API слушает порт 8000. Если прямое соединение на этот порт закрыто, а задан
HTTPS_PROXY, запросы идут туннелем через прокси (curl -p).
"""
import json
import os
import subprocess
import sys
import time
import urllib.parse
from datetime import date
from pathlib import Path

API = 'http://actual.pravo.gov.ru:8000/api/ebpi/'
SITE = 'http://actual.pravo.gov.ru/'

# Реквизиты документов: номер, дата подписания, ограничение «только законы» (у постановления его нет).
DOCS = {
    'pdd': {'number': '1090', 'date': '19931023', 'laws_only': 0,
            'title': 'Постановление Совета Министров — Правительства РФ от 23.10.1993 № 1090 «О Правилах дорожного движения»'},
    'koap': {'number': '195-ФЗ', 'date': '20011230', 'laws_only': 1,
             'title': 'Кодекс РФ об административных правонарушениях от 30.12.2001 № 195-ФЗ'},
    'uk': {'number': '63-ФЗ', 'date': '19960613', 'laws_only': 1,
           'title': 'Уголовный кодекс РФ от 13.06.1996 № 63-ФЗ'},
}


def get(path: str, tries: int = 4) -> str:
    cmd = ['curl', '-sS', '-m', '300', '-A', 'Crashtest-law-fetch']
    if os.environ.get('HTTPS_PROXY'):
        cmd += ['--proxy', os.environ['HTTPS_PROXY'], '-p']
    for k in range(tries):
        r = subprocess.run(cmd + [API + path], capture_output=True, text=True)
        if r.returncode == 0 and r.stdout.startswith('{'):
            return r.stdout
        time.sleep(3 * (k + 1))
    sys.exit(f'портал не ответил: {path[:80]}')


def query(path: str, params: dict) -> dict:
    return json.loads(get(path + '?' + urllib.parse.urlencode(params)))


def find(cfg: dict) -> dict:
    attrs = [
        {'AttrId': 6, 'AttrMode': 0, 'Words': [cfg['number']]},
        {'AttrId': 5, 'AttrMode': 0, 'DateFrom': cfg['date'], 'DateTo': cfg['date']},
        {'AttrId': 999, 'AttrMode': 1, 'Words': [20, '-date', '20220701', 0, cfg['laws_only']]},
    ]
    r = query('attrsearch/', {'bpa': 'ebpi', 'q': json.dumps(attrs, ensure_ascii=False)})
    docs = [d for d in r.get('docs') or [] if d.get('docpass0number') == cfg['number'] and d.get('docpass0date') == cfg['date']]
    if len(docs) != 1:
        sys.exit(f'документ {cfg["number"]} от {cfg["date"]} не найден однозначно: {len(docs)}')
    return docs[0]


def main() -> None:
    cache = Path(sys.argv[1])
    cache.mkdir(parents=True, exist_ok=True)
    meta = {'fetched': date.today().isoformat(), 'source': 'ИПС «Законодательство России», actual.pravo.gov.ru', 'docs': {}}
    for key, cfg in DOCS.items():
        doc = find(cfg)
        reds = query('redactions/', {'bpa': 'ebpi', 't': json.dumps({'hash': doc['dochash'], 'ttl': 3})}).get('redactions') or []
        actual = [x for x in reds if x.get('actual')]
        if len(actual) != 1:
            sys.exit(f'{key}: нет однозначной актуальной редакции')
        red = actual[0]
        if not red.get('redcompleted'):
            sys.exit(f'{key}: текст актуальной редакции на портале ещё не готов ({red.get("redcaption")})')
        text = json.loads(get(f'redtext?bpa=ebpi&t={red["redid"]}&ttl=0')).get('redtext') or ''
        if len(text) < 50000:
            sys.exit(f'{key}: подозрительно короткий текст ({len(text)} символов)')
        (cache / f'{key}.html').write_text(text, encoding='utf-8')
        upcoming = [x for x in reds if not x.get('actual') and x.get('reddate', '') > red['reddate']]
        meta['docs'][key] = {
            'title': cfg['title'],
            'docpassing': doc.get('docpassing'),
            'hash': doc['dochash'],
            'url': f'{SITE}content/content.html#hash={doc["dochash"]}',
            'redaction': red['redid'],
            'redactionDate': f'{red["reddate"][6:8]}.{red["reddate"][4:6]}.{red["reddate"][:4]}',
            'redactionCaption': red.get('redcaption', '').strip(),
            'official': bool(red.get('redofficial')),
            'upcoming': [{'date': f'{x["reddate"][6:8]}.{x["reddate"][4:6]}.{x["reddate"][:4]}', 'caption': x.get('redcaption', '').strip()} for x in upcoming],
        }
        print(f'{key}: редакция {meta["docs"][key]["redactionDate"]}, {len(text)} символов'
              + (f'; впереди редакций: {len(upcoming)}' if upcoming else ''))
    (cache / 'meta.json').write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding='utf-8')


if __name__ == '__main__':
    main()
