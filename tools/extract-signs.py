#!/usr/bin/env python3
"""Достаёт картинки знаков и разметки из PDF «ПДД 2026 от pddmaster.ru» и сопоставляет их с номерами.

В PDF подпись (жирный номер) стоит над картинкой, текст идёт в три колонки. Для каждой подписи
берём картинки той же колонки между ней и следующей подписью.

Использование: python3 tools/extract-signs.py <pdf> <рабочий-каталог> <каталог-public>
Результат: <public>/signs/*.png, <public>/markings/*.png и tools/out/sign-images.json
"""
import json
import re
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

pdf, work, public = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
work.mkdir(parents=True, exist_ok=True)
FIRST, LAST = 29, 46

subprocess.run(['pdftohtml', '-xml', '-f', str(FIRST), '-l', str(LAST), '-zoom', '1', str(pdf), str(work / 'pdd')], check=True, capture_output=True)
xml = (work / 'pdd.xml').read_text(encoding='utf-8')

NUM = r'\d+(?:\.\d+)*'
LIST_RE = re.compile(rf'^{NUM}(?:\s*[,–-]\s*{NUM})*$')


def expand(s: str) -> list[str]:
    """'1.4.1 - 1.4.6' -> 1.4.1 ... 1.4.6; '1.11.1, 1.11.2' -> две записи."""
    s = s.replace('–', '-').replace('\xa0', ' ')
    out: list[str] = []
    for part in [p.strip() for p in s.split(',')]:
        m = re.match(rf'^({NUM})\s*-\s*({NUM})$', part)
        if m:
            a, b = m.group(1), m.group(2)
            pa, pb = a.split('.'), b.split('.')
            if len(pa) == len(pb) and pa[:-1] == pb[:-1] and pa[-1].isdigit() and pb[-1].isdigit():
                out += ['.'.join(pa[:-1] + [str(n)]) for n in range(int(pa[-1]), int(pb[-1]) + 1)]
                continue
            out += [a, b]
        elif re.match(rf'^{NUM}$', part):
            out.append(part)
    return out


def col(left: float) -> int:
    return 0 if left < 205 else 1 if left < 392 else 2


items = []  # {kind, id, files}
kind = 'sign'
for pm in re.finditer(r'<page number="(\d+)".*?</page>', xml, re.S):
    page = int(pm.group(1))
    body = pm.group(0)
    imgs = []
    for m in re.finditer(r'<image top="(\d+)" left="(\d+)" width="(\d+)" height="(\d+)" src="([^"]+)"/>', body):
        top, left, w, h, src = int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4)), m.group(5)
        if top > 735 and left > 480:
            continue  # QR-код
        if w > 120 or h > 120:
            continue
        imgs.append({'top': top, 'left': left, 'w': w, 'h': h, 'src': src})
    events = []  # (top, col, type, payload)
    for m in re.finditer(r'<text top="(\d+)" left="(\d+)" width="(\d+)" height="(\d+)" font="(\d+)">(.*?)</text>', body):
        top, left, txt = int(m.group(1)), int(m.group(2)), m.group(6)
        plain = re.sub(r'<[^>]+>', '', txt).replace('&#34;', '"').strip()
        if 'Приложение 2' in plain and plain.startswith('Приложение 2'):
            events.append((top, col(left), 'mark', 'marking-h'))
        if plain.startswith('Вертикальная разметка'):
            events.append((top, col(left), 'mark', 'marking-v'))
        b = re.match(r'^\s*<b>(.*?)</b>', txt)
        if b:
            cap = re.sub(r'<[^>]+>', '', b.group(1)).replace('&#34;', '"').strip().rstrip('-–').strip()
            if LIST_RE.match(cap):
                events.append((top, col(left), 'cap', cap))
    # «5.7.1, 5.7.2» набраны двумя жирными фрагментами в одной строке — склеиваем подпись
    merged = []
    for e in sorted(events, key=lambda x: (x[1], x[0])):
        if merged and e[2] == 'cap' and merged[-1][2] == 'cap' and merged[-1][1] == e[1] and abs(merged[-1][0] - e[0]) <= 2:
            merged[-1] = (merged[-1][0], e[1], 'cap', merged[-1][3] + ', ' + e[3])
        else:
            merged.append(e)
    events = merged
    # раскладываем события и картинки по колонкам
    for c in range(3):
        seq = [(e[0], 0, e) for e in events if e[1] == c]
        seq += [(i['top'] + 0.5, 1, i) for i in imgs if col(i['left']) == c]
        seq.sort(key=lambda x: (x[0], x[1]))
        cur = None
        for _, order, obj in seq:
            if order == 0 and obj[2] == 'mark':
                kind = obj[3]
                cur = None
            elif order == 0:
                if kind == 'sign' and obj[3].count('.') == 0:
                    cur = None
                    continue
                cur = {'kind': kind, 'ids': expand(obj[3]), 'imgs': [], 'page': page}
                items.append(cur)
            elif cur is not None:
                cur['imgs'].append(obj)
            elif items and not items[-1]['imgs']:
                # картинка в начале колонки/страницы, а подпись осталась внизу предыдущей
                items[-1]['imgs'].append(obj)

# --- ручные поправки: знаки 4.1.1-4.1.6 набраны в абзаце и показаны сеткой 3x2 (страница 34)
for it in list(items):
    if it['page'] == 34 and it['ids'] and it['ids'][0].startswith('4.1.') and not it['imgs']:
        items.remove(it)
pm34 = re.search(r'<page number="34".*?</page>', xml, re.S)
grid = []
for m in re.finditer(r'<image top="(\d+)" left="(\d+)" width="(\d+)" height="(\d+)" src="([^"]+)"/>', pm34.group(0) if pm34 else ''):
    top, left, w, h, src = int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4)), m.group(5)
    if left < 205 and 190 <= top <= 300 and 40 <= w <= 70:
        grid.append({'top': top, 'left': left, 'w': w, 'h': h, 'src': src})
grid.sort(key=lambda i: (round(i['top'] / 20), i['left']))
if len(grid) == 6:
    for n, im in enumerate(grid):
        items.append({'kind': 'sign', 'ids': [f'4.1.{n + 1}'], 'imgs': [im], 'page': 34})

# --- сохраняем картинки

def clean(src: Path, dst: Path) -> None:
    """Белый фон снаружи знака делаем прозрачным (заливка от краёв), внутренние белые поля остаются."""
    im = Image.open(src).convert('RGBA')
    w, h = im.size
    big = im.resize((w * 2, h * 2), Image.LANCZOS)
    for pt in [(0, 0), (big.width - 1, 0), (0, big.height - 1), (big.width - 1, big.height - 1)]:
        px = big.getpixel(pt)
        if px[0] > 235 and px[1] > 235 and px[2] > 235:
            ImageDraw.floodfill(big, pt, (255, 255, 255, 0), thresh=28)
    big.save(dst, 'WEBP', quality=92, method=6)


for d in ('signs', 'markings'):
    (public / d).mkdir(parents=True, exist_ok=True)
result: dict[str, dict] = {}
report = []
for it in items:
    ids, files = it['ids'], it['imgs']
    if not ids or not files:
        report.append(f"нет картинок: {it['kind']} {it['ids']} (стр. {it['page']})")
        continue
    files = sorted(files, key=lambda i: (round(i['top'] / 6), i['left']))
    folder = 'markings' if it['kind'].startswith('marking') else 'signs'
    prefix = 'v' if it['kind'] == 'marking-v' else ''
    for k, sid in enumerate(ids):
        key = f"{it['kind']}:{sid}"
        if len(files) == len(ids):
            picks = [files[k]]
        elif len(files) == 1:
            picks = files
        else:
            picks = files  # сложная группа: все картинки подписи
        names = []
        for n, f in enumerate(picks):
            name = f"{prefix}{sid}{'' if len(picks) == 1 else '_' + str(n + 1)}.webp"
            dst = public / folder / name
            if not dst.exists():
                clean(work / f['src'], dst)
            names.append(f"{folder}/{name}")
        if key in result:
            report.append(f'повтор {key}: стр. {it["page"]} и ранее')
        result[key] = {'kind': it['kind'], 'id': sid, 'files': names, 'group': len(ids) if len(files) != len(ids) else 1}
out = Path(__file__).parent / 'out'
out.mkdir(exist_ok=True)
(out / 'sign-images.json').write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding='utf-8')
(out / 'sign-images.report.txt').write_text('\n'.join(report), encoding='utf-8')
by = {}
for v in result.values():
    by[v['kind']] = by.get(v['kind'], 0) + 1
print(by, 'замечаний:', len(report))
