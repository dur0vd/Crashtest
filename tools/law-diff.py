#!/usr/bin/env python3
"""Сравнивает два корпуса норм (каталоги с pdd.json, koap.json, uk.json, signs.json, markings.json).

Использование: python3 -I tools/law-diff.py <старый src/data> <новый src/data> > docs/law-diff-ГГГГ-ММ-ДД.md

Перед сравнением тексты нормализуются: оформление источника («N»/«№», тире, сноски «<*>»,
пробелы) не считается изменением. Сначала выводятся нормы, на которые ссылается разбор
(идентификаторы из src/*.ts) — их нужно проверить в первую очередь.
"""
import difflib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
old_dir, new_dir = Path(sys.argv[1]), Path(sys.argv[2])


def norm(t: str) -> str:
    t = t.replace('№', 'N').replace('<*>', '').replace('*', '')
    t = re.sub(r'[—–]', '-', t)
    t = re.sub(r'(\d)\((\d+)\)', r'\1.\2', t)  # 13.11(1) ↔ 13.11.1 в ссылках внутри текста
    t = re.sub(r'\s+', ' ', t)
    t = re.sub(r'\s+([,.;:)])', r'\1', t)
    return t.strip()


def flatten(d: Path) -> dict[str, str]:
    """Идентификатор ссылки (как в разборе) → текст нормы."""
    out: dict[str, str] = {}
    pdd = json.loads((d / 'pdd.json').read_text(encoding='utf-8'))
    for s in pdd['sections']:
        for p in s['points']:
            out[f'pdd:{p["id"]}'] = p['text']
    for p in pdd['basics']['points']:
        out[f'pdd:op:{p["id"]}'] = p['text']
    for code in ('koap', 'uk'):
        for a in json.loads((d / f'{code}.json').read_text(encoding='utf-8'))['articles']:
            for p in a['parts']:
                out[f'{code}:{a["id"]}' + (f'.{p["n"]}' if p['n'] else '')] = p['text']
            if a['notes']:
                out[f'{code}:{a["id"]}:примечания'] = '\n'.join(a['notes'])
    for g in json.loads((d / 'signs.json').read_text(encoding='utf-8'))['groups']:
        for s in g['signs']:
            out[f'sign:{s["id"]}'] = s['text']
    m = json.loads((d / 'markings.json').read_text(encoding='utf-8'))
    for k in ('horizontal', 'vertical'):
        for s in m[k]['items']:
            out[f'marking:{s["id"]}'] = s['text']
    return out


def used_refs() -> set[str]:
    refs = set()
    for f in (ROOT / 'src').glob('*.ts'):
        refs |= set(re.findall(r"'((?:pdd|koap|uk|sign|marking):[^'#\s]+)", f.read_text(encoding='utf-8')))
    return refs


def word_diff(a: str, b: str) -> str:
    wa, wb = norm(a).split(' '), norm(b).split(' ')
    out = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, wa, wb).get_opcodes():
        if op == 'equal':
            seg = wa[i1:i2]
            out.append(' '.join(seg) if len(seg) <= 12 else ' '.join(seg[:5]) + ' … ' + ' '.join(seg[-5:]))
        else:
            if i2 > i1:
                out.append('~~' + ' '.join(wa[i1:i2]) + '~~')
            if j2 > j1:
                out.append('**' + ' '.join(wb[j1:j2]) + '**')
    return ' '.join(out)


def main() -> None:
    old, new = flatten(old_dir), flatten(new_dir)
    used = used_refs()
    changed = sorted(k for k in old.keys() & new.keys() if norm(old[k]) != norm(new[k]))
    added = sorted(new.keys() - old.keys())
    removed = sorted(old.keys() - new.keys())
    meta = json.loads((new_dir / 'pdd.json').read_text(encoding='utf-8'))
    print('# Сравнение корпуса норм\n')
    print(f'Новый корпус выгружен {meta["fetched"]}. Источник: {meta["sources"]["pdd"].split(";")[0]}.\n')
    for k, e in meta.get('editions', {}).items():
        print(f'- {k}: редакция {e["date"]} — {e["caption"]}')
    print(f'\nИзменилось по тексту: {len(changed)}, появилось: {len(added)}, исчезло: {len(removed)}. '
          'Оформление (N/№, тире, сноски, пробелы) изменением не считается.\n')
    hot = [k for k in changed if k in used or k.split(':')[0] + ':' + k.split(':')[1].rsplit('.', 1)[0] in used]
    print('## Нормы, на которые ссылается разбор\n')
    if not hot:
        print('Изменений нет.\n')
    for k in hot:
        print(f'### `{k}`\n\n{word_diff(old[k], new[k])}\n')
    print('## Остальные изменения по тексту\n')
    for k in changed:
        if k not in hot:
            print(f'### `{k}`\n\n{word_diff(old[k], new[k])}\n')
    print('## Появились\n')
    for k in added:
        print(f'- `{k}`' + (' (используется разбором)' if k in used else '') + f': {norm(new[k])[:160]}')
    print('\n## Исчезли\n')
    for k in removed:
        print(f'- `{k}`' + (' (используется разбором!)' if k in used else '') + f': {norm(old[k])[:160]}')


if __name__ == '__main__':
    main()
