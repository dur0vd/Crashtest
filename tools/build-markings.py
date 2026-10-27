#!/usr/bin/env python3
"""Генерирует SVG-изображения горизонтальной и вертикальной разметки (приложения 2 к ПДД).

Запуск из корня репозитория: python3 -I tools/build-markings.py

Размеры — в миллиметрах. Высота картинки — 3200 мм: редактор кладёт рисунок вдоль дороги,
верх картинки совпадает с направлением движения, а ширина выводится из пропорций.
Пропорции и толщины линий приближены к ГОСТ Р 51256-2018 и к описаниям приложения 2.
Пиктограммы и символы — упрощённая собственная отрисовка, а не копии официальных изображений.

Результат: public/markings/*.svg и public/markings/SOURCES.json.
"""
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
INDEX = os.path.join(ROOT, 'src/data/marking-index.json')
OUT = os.path.join(ROOT, 'public/markings')

H = 3200
WHITE = '#f2f4f8'
YELLOW = '#ffcf3d'
DARK = '#1b1f27'


def svg(w, h, body):
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">{body}</svg>\n'


def rect(x, y, w, h, fill=WHITE):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}"/>'


def dashes(x, w, dash, gap, length=H, fill=WHITE):
    out, y = [], 0
    while y < length:
        out.append(rect(x, y, w, min(dash, length - y), fill))
        y += dash + gap
    return ''.join(out)


def poly(points, width, color=WHITE):
    pts = ' '.join(f'{x},{y}' for x, y in points)
    return f'<polyline points="{pts}" fill="none" stroke="{color}" stroke-width="{width}" stroke-linejoin="round"/>'


def outline(pts, width, color=WHITE):
    pts = pts + pts[:1]
    return poly(pts, width, color)


def hatch(pts_svg_shape, id_):
    """Штриховка диагональными полосами внутри фигуры (через pattern)."""
    pattern = (
        f'<defs><pattern id="{id_}" patternUnits="userSpaceOnUse" width="300" height="300" patternTransform="rotate(45)">'
        f'<rect width="120" height="300" fill="{WHITE}"/></pattern></defs>'
    )
    return pattern + pts_svg_shape.replace('FILL', f'url(#{id_})')


def circle(cx, cy, r, stroke=WHITE, sw=60, fill='none'):
    return f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>'


def text(x, y, s, size, rot=0, fill=WHITE, anchor='middle'):
    tr = f' transform="rotate({rot} {x} {y})"' if rot else ''
    return (
        f'<text x="{x}" y="{y}" font-family="Arial, Helvetica, sans-serif" font-size="{size}" '
        f'font-weight="700" fill="{fill}" text-anchor="{anchor}" dominant-baseline="middle"{tr}>{s}</text>'
    )


def bicycle(cx, cy, s, color=WHITE):
    """Велосипед: два колеса и рама. s — размер пиктограммы в мм."""
    r = 0.2 * s
    lw = 0.05 * s
    wl, wr = (cx - 0.3 * s, cy + 0.15 * s), (cx + 0.3 * s, cy + 0.15 * s)
    seat, bar, bottom = (cx - 0.05 * s, cy - 0.2 * s), (cx + 0.2 * s, cy - 0.25 * s), (cx + 0.02 * s, cy + 0.15 * s)
    return (
        circle(wl[0], wl[1], r, color, lw)
        + circle(wr[0], wr[1], r, color, lw)
        + poly([wl, bottom, seat, wl], lw, color)
        + poly([bottom, wr, bar, seat], lw, color)
    )


def bus(cx, cy, s):
    """Автобус: кузов, окна и колёса."""
    w, h = 0.7 * s, 0.5 * s
    x0, y0 = cx - w / 2, cy - h / 2
    body = f'<rect x="{x0}" y="{y0}" width="{w}" height="{h}" rx="{0.08 * s}" fill="{WHITE}"/>'
    win = f'<rect x="{x0 + 0.07 * s}" y="{y0 + 0.08 * s}" width="{w - 0.14 * s}" height="{0.18 * s}" fill="{DARK}"/>'
    wheels = ''.join(circle(cx + dx * s, cy + 0.3 * s, 0.07 * s, WHITE, 0.0, WHITE) for dx in (-0.23, 0.23))
    return body + win + wheels


def wheelchair(cx, cy, s):
    head = f'<circle cx="{cx - 0.05 * s}" cy="{cy - 0.3 * s}" r="{0.08 * s}" fill="{WHITE}"/>'
    body = poly([(cx - 0.05 * s, cy - 0.2 * s), (cx - 0.05 * s, cy + 0.05 * s), (cx + 0.15 * s, cy + 0.05 * s)], 0.07 * s)
    wheel = circle(cx - 0.05 * s, cy + 0.2 * s, 0.2 * s, WHITE, 0.06 * s)
    return head + body + wheel


def camera(cx, cy, s):
    body = f'<rect x="{cx - 0.3 * s}" y="{cy - 0.18 * s}" width="{0.6 * s}" height="{0.36 * s}" rx="{0.06 * s}" fill="{WHITE}"/>'
    lens = f'<circle cx="{cx}" cy="{cy}" r="{0.11 * s}" fill="{DARK}"/>'
    return body + lens


def stripes_bg(w, h, color_a, color_b, period=200):
    out = [rect(0, 0, w, h, color_b)]
    x = 0
    while x < w + h:
        out.append(f'<polygon points="{x},0 {x + period // 2},0 {x + period // 2 - h},{h} {x - h},{h}" fill="{color_a}"/>')
        x += period
    return ''.join(out)


def zebra(w, stripe=500, pitch=1000):
    return ''.join(rect(x, 0, stripe, H) for x in range(0, w - stripe + 1, pitch))


def triangles_row(x0, y, count, base, height, pitch):
    out = []
    for k in range(count):
        x = x0 + k * pitch
        out.append(f'<polygon points="{x},{y} {x + base},{y} {x + base / 2},{y + height}" fill="{WHITE}"/>')
    return ''.join(out)


# Каждая картинка: (ширина в мм, тело SVG). Ключ — имя файла без расширения.
def build():
    B = {}
    # --- 1. Горизонтальная разметка: линии ---
    B['1.1'] = (150, rect(25, 0, 100, H))
    B['1.2'] = (150, rect(25, 0, 100, H))
    B['1.3'] = (350, rect(25, 0, 100, H) + rect(225, 0, 100, H))
    B['1.4'] = (250, rect(25, 0, 200, H, YELLOW))
    B['1.5'] = (150, dashes(25, 100, 1000, 3000))
    B['1.6'] = (150, dashes(25, 100, 3000, 1000))
    B['1.7_1'] = (150, dashes(25, 100, 1000, 1000))
    B['1.8'] = (350, dashes(25, 300, 3000, 1000))
    B['1.9'] = (550, dashes(25, 100, 3000, 3000) + dashes(425, 100, 3000, 3000))
    B['1.10'] = (250, dashes(25, 200, 1000, 1000, fill=YELLOW))
    B['1.11'] = (550, rect(25, 0, 100, H) + dashes(425, 100, 3000, 3000))
    B['1.12'] = (3000, rect(0, 1300, 3000, 600))
    B['1.13'] = (3000, triangles_row(0, 1200, 5, 500, 500, 600))
    B['1.14.2_1'] = (3000, zebra(3000))
    B['1.14.3'] = (3000, ''.join(f'<line x1="{x}" y1="0" x2="{x + H}" y2="{H}" stroke="{WHITE}" stroke-width="500"/>' for x in range(-H, 3000, 1000)))
    B['1.15'] = (1500, dashes(200, 100, 1000, 500) + dashes(1200, 100, 1000, 500))
    # --- 1. Островки (области) ---
    B['1.16.1'] = (1000, hatch(f'<rect x="50" y="50" width="900" height="{H - 100}" fill="FILL" stroke="{WHITE}" stroke-width="100"/>', 'h161'))
    B['1.16.2'] = (1000, hatch(f'<rect x="50" y="50" width="900" height="{H - 100}" rx="300" fill="FILL" stroke="{WHITE}" stroke-width="100"/>', 'h162'))
    B['1.16.3'] = (1000, hatch(f'<polygon points="500,100 950,{H - 100} 50,{H - 100}" fill="FILL" stroke="{WHITE}" stroke-width="100"/>', 'h163'))
    # --- 1. Остановки (зигзаг, жёлтый) ---
    zig = [(80, y) if (y // 200) % 2 == 0 else (320, y) for y in range(0, H + 1, 200)]
    B['1.17.1'] = (400, poly(zig, 80, YELLOW))
    B['1.17.2'] = (400, poly(zig, 80, YELLOW))
    # --- 1. Стрелы и символы ---
    B['1.18_1'] = (900, rect(400, 800, 100, 2400) + f'<polygon points="450,400 800,800 100,800" fill="{WHITE}"/>')
    B['1.19_1'] = (1000, f'<polygon points="150,{H} 290,{H} 500,900 580,900 500,800" fill="{WHITE}"/>'
                   + f'<polygon points="850,{H} 710,{H} 500,900 420,900 500,800" fill="{WHITE}"/>')
    B['1.20'] = (3000, triangles_row(300, 1300, 4, 500, 500, 700))
    B['1.21'] = (3000, rect(300, 800, 2400, 200) + rect(300, 1500, 2400, 200) + rect(300, 2200, 2400, 200))
    B['1.22_1'] = (1200, f'<rect x="100" y="700" width="1000" height="1800" rx="200" fill="{WHITE}"/>' + text(600, 1600, 'А-101', 300, rot=-90, fill=DARK))
    B['1.23.1'] = (1000, bus(500, 1600, 1000))
    B['1.23.2'] = (1000, bicycle(500, 1600, 900))
    B['1.23.3'] = (1000, f'<rect x="50" y="1000" width="900" height="1200" rx="120" fill="none" stroke="{WHITE}" stroke-width="80"/>' + bicycle(500, 1600, 700))
    B['1.24.1'] = (1000, outline([(500, 1100), (900, 2000), (100, 2000)], 90))
    B['1.24.2'] = (1000, circle(500, 1600, 380, WHITE, 90))
    B['1.24.3'] = (1000, wheelchair(500, 1600, 1000))
    B['1.24.4'] = (1000, camera(500, 1600, 1000))
    B['1.24.5'] = (1000, f'<rect x="100" y="900" width="800" height="1400" fill="none" stroke="{WHITE}" stroke-width="80"/>' + text(500, 1600, '8.4.3.1', 150, rot=-90))
    B['1.24.6'] = (1000, f'<rect x="100" y="1000" width="800" height="1200" fill="none" stroke="{WHITE}" stroke-width="80"/>' + bicycle(500, 1600, 600))
    B['1.24.7'] = (1000, circle(500, 1600, 380, WHITE, 80) + text(500, 1600, 'Д', 420))
    B['1.25'] = (3000, ''.join(rect(200, y, 2600, 180) for y in range(400, H, 600)))
    B['1.26'] = (3000, hatch(f'<rect x="200" y="200" width="2600" height="{H - 400}" fill="FILL" stroke="{WHITE}" stroke-width="80"/>', 'h126'))
    # --- 2. Вертикальная разметка (сооружения, ограждения) ---
    B['v2.1.1_1'] = (400, stripes_bg(400, H, DARK, WHITE, 200))
    B['v2.1.2_1'] = (400, rect(0, 0, 400, H) + ''.join(rect(x, 0, 100, H, DARK) for x in range(0, 400, 200)))
    B['v2.1.3_1'] = (400, rect(0, 0, 400, H) + ''.join(rect(0, y, 400, 100, DARK) for y in range(0, H, 200)))
    B['v2.2'] = (1000, rect(0, 1400, 1000, 200))
    B['v2.3'] = (800, ''.join(circle(400, y, 100, WHITE, 0, WHITE) for y in (800, 1600, 2400)))
    B['v2.4_1'] = (400, ''.join(rect(150, y, 100, 300) for y in range(0, H, 800)))
    B['v2.5'] = (1200, f'<path d="M 100 0 Q 1100 1600 100 {H}" fill="none" stroke="{WHITE}" stroke-width="150"/>')
    B['v2.6'] = (300, rect(75, 0, 150, H))
    B['v2.7'] = (300, rect(0, 0, 300, H))
    return B


def main():
    index = json.load(open(INDEX, encoding='utf-8'))
    builders = build()
    os.makedirs(OUT, exist_ok=True)

    files = {}
    for mid, (title, path) in index.items():
        base = os.path.splitext(os.path.basename(path))[0]
        files.setdefault(base, []).append(mid)
    missing = [f for f in files if f not in builders]
    if missing:
        sys.exit(f'нет описания для файлов: {missing}')

    items = []
    for base, ids in sorted(files.items()):
        w, body = builders[base]
        with open(os.path.join(OUT, base + '.svg'), 'w', encoding='utf-8') as f:
            f.write(svg(w, H, body))
        items.append({
            'file': f'markings/{base}.svg',
            'ids': sorted(ids),
            'source': 'собственная отрисовка (скрипт tools/build-markings.py)',
            'license': 'проприетарная, как и приложение: правообладатель — владелец проекта',
            'author': 'владелец проекта Crashtest',
            'attribution': None,
            'simplified': True,
        })

    manifest = {
        'description': 'Изображения разметки приложения 2 к ПДД. Все файлы — собственная отрисовка, генерируются скриптом.',
        'generator': 'tools/build-markings.py',
        'items': items,
    }
    with open(os.path.join(OUT, 'SOURCES.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(f'файлов: {len(items)}')


if __name__ == '__main__':
    main()
