#!/usr/bin/env python3
"""Генерирует SVG-знаки приложения 1 к ПДД (собственная отрисовка) и обновляет индекс знаков.

Запуск из корня репозитория: python3 -I tools/build-signs.py

Для каждого знака создаётся public/signs/<номер>.svg: форма и цвета по группе (ГОСТ Р 52290-2004),
внутри — номер знака. Это ЗАГЛУШКИ: пиктограммы не нарисованы. Знаки, для которых в
public/signs/SOURCES.json указан внешний файл (например, с Wikimedia Commons), скрипт не трогает.
Номер знака не выводится на знаках со значением: значение рисует само приложение (VALUE_SIGNS).

Также пересобирает src/data/sign-index.json и поле img в src/data/signs.json: один файл на номер знака.
"""
import json
import math
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.join(ROOT, 'public/signs')
DATA = os.path.join(ROOT, 'src/data')
MANIFEST = os.path.join(OUT, 'SOURCES.json')

RED = '#d7262c'
BLUE = '#1b5fb5'
YELLOW = '#f2c230'
WHITE = '#ffffff'
BLACK = '#111111'


def svg(w, h, body):
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">{body}</svg>\n'


def label(x, y, s, size, fill):
    return (f'<text x="{x}" y="{y}" font-family="Arial, Helvetica, sans-serif" font-size="{size}" font-weight="700" '
            f'fill="{fill}" text-anchor="middle" dominant-baseline="middle">{s}</text>')


def shape(sign_id, group):
    """Возвращает (ширина, высота, тело SVG) для знака. Форма — по группе и, для 2.x, по номеру."""
    if group == '8':
        return 300, 180, (f'<rect x="4" y="4" width="292" height="172" rx="8" fill="{WHITE}" stroke="{BLACK}" stroke-width="8"/>'
                          + label(150, 90, sign_id, 46, BLACK))
    if group == '1':
        body = f'<polygon points="100,14 186,176 14,176" fill="{WHITE}" stroke="{RED}" stroke-width="20" stroke-linejoin="round"/>'
        return 200, 200, body + label(100, 130, sign_id, 38, BLACK)
    if group == '2':
        if sign_id == '2.1':
            body = f'<polygon points="100,8 192,100 100,192 8,100" fill="{YELLOW}" stroke="{WHITE}" stroke-width="12" stroke-linejoin="round"/>'
            return 200, 200, body + label(100, 100, sign_id, 40, BLACK)
        if sign_id == '2.4':
            body = f'<polygon points="10,22 190,22 100,186" fill="{WHITE}" stroke="{RED}" stroke-width="20" stroke-linejoin="round"/>'
            return 200, 200, body + label(100, 80, sign_id, 36, BLACK)
        if sign_id == '2.5':
            pts = ' '.join(f'{100 + 90 * math.cos(a):.1f},{100 + 90 * math.sin(a):.1f}'
                           for a in [k * math.pi / 4 + math.pi / 8 for k in range(8)])
            return 200, 200, f'<polygon points="{pts}" fill="{RED}" stroke="{WHITE}" stroke-width="8"/>' + label(100, 100, 'СТОП', 34, WHITE)
        body = f'<rect x="12" y="12" width="176" height="176" fill="{WHITE}" stroke="{RED}" stroke-width="16"/>'
        return 200, 200, body + label(100, 100, sign_id, 36, BLACK)
    if group == '3':
        body = f'<circle cx="100" cy="100" r="90" fill="{WHITE}" stroke="{RED}" stroke-width="20"/>'
        return 200, 200, body + label(100, 100, sign_id, 40, BLACK)
    if group == '4':
        body = f'<circle cx="100" cy="100" r="96" fill="{BLUE}"/>'
        return 200, 200, body + label(100, 100, sign_id, 40, WHITE)
    # 5, 6, 7 — информационные: синий прямоугольник
    body = f'<rect x="6" y="6" width="188" height="188" rx="10" fill="{BLUE}"/>'
    return 200, 200, body + label(100, 100, sign_id, 40, WHITE)


def load_external():
    """Номера знаков, для которых в манифесте уже указан внешний файл (их не перезаписываем)."""
    if not os.path.exists(MANIFEST):
        return set()
    manifest = json.load(open(MANIFEST, encoding='utf-8'))
    return {i for item in manifest.get('items', []) if item.get('source', '').startswith('Wikimedia') for i in item.get('ids', [])}


def main():
    signs_json = json.load(open(os.path.join(DATA, 'signs.json'), encoding='utf-8'))
    external = load_external()
    os.makedirs(OUT, exist_ok=True)

    index, items = {}, []
    for group in signs_json['groups']:
        for s in group['signs']:
            sid = s['id']
            file_rel = f'signs/{sid}.svg'
            index[sid] = [s['title'], file_rel]
            s['img'] = file_rel
            if sid in external:
                continue
            w, h, body = shape(sid, str(s['group']))
            with open(os.path.join(OUT, f'{sid}.svg'), 'w', encoding='utf-8') as f:
                f.write(svg(w, h, body))
            items.append({
                'file': file_rel,
                'ids': [sid],
                'source': 'собственная отрисовка (скрипт tools/build-signs.py): заглушка, пиктограмма не нарисована',
                'license': 'проприетарная, как и приложение: правообладатель — владелец проекта',
                'author': 'владелец проекта Crashtest',
                'attribution': None,
                'status': 'заглушка',
            })

    # индекс знаков: один файл на номер (см. src/signs.ts)
    with open(os.path.join(DATA, 'sign-index.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, separators=(',', ':'))
        f.write('\n')
    with open(os.path.join(DATA, 'signs.json'), 'w', encoding='utf-8') as f:
        json.dump(signs_json, f, ensure_ascii=False, indent=2)
        f.write('\n')

    # манифест: собственные заглушки дописываются, внешние записи сохраняются
    old = json.load(open(MANIFEST, encoding='utf-8')) if os.path.exists(MANIFEST) else {'items': []}
    kept = [i for i in old.get('items', []) if i.get('source', '').startswith('Wikimedia')]
    manifest = {
        'description': 'Изображения знаков приложения 1 к ПДД. Внешние файлы — с Wikimedia Commons (лицензия указана по каждому файлу). Остальные — собственная отрисовка.',
        'generator': 'tools/build-signs.py',
        'items': kept + items,
    }
    with open(MANIFEST, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(f'знаков: {len(index)}, собственных заглушек: {len(items)}, внешних: {len(kept)}')


if __name__ == '__main__':
    main()
