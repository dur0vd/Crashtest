"""Пиктограммы знаков приложения 1 к ПДД — собственная отрисовка по ГОСТ Р 52290-2004 (упрощённо).

Подключается из tools/build-signs.py. Каждая функция возвращает (ширина, высота, тело SVG)
или None, если знак пока не нарисован (тогда build-signs.py рисует заглушку с номером).
Координаты основных знаков — поле 200×200; пиктограммы описаны в поле 100×100
и переносятся функцией place().
"""
import math

RED = '#d7262c'
BLUE = '#1b5fb5'
YELLOW = '#f2c230'
WHITE = '#ffffff'
BLACK = '#111111'
GREY = '#7d838b'
ORANGE = '#f08a24'
GREEN = '#1f9a4a'


# ---------------------------------------------------------------- основа

def text(x, y, s, size, fill=BLACK, weight=700, anchor='middle'):
    s = s.replace('&', '&amp;').replace('<', '&lt;')
    return (f'<text x="{x}" y="{y}" font-family="Arial, Helvetica, sans-serif" font-size="{size}" font-weight="{weight}" '
            f'fill="{fill}" text-anchor="{anchor}" dominant-baseline="central">{s}</text>')


def place(body, cx, cy, size, flip=False):
    """Пиктограмма из поля 100×100 с центром (50, 50) → квадрат size×size с центром (cx, cy)."""
    k = size / 100
    fx = f' translate(100,0) scale(-1,1)' if flip else ''
    return f'<g transform="translate({cx - size / 2:.1f},{cy - size / 2:.1f}) scale({k:.4f}){fx}">{body}</g>'


def shrink(body, k, cx=100, cy=100):
    """Уменьшает рисунок из поля 200×200 относительно точки (cx, cy)."""
    return f'<g transform="translate({cx},{cy}) scale({k}) translate(-100,-100)">{body}</g>'


def recolor(body, color):
    return body.replace(BLACK, color)


def arrow(points, color=BLACK, w=12, head=26):
    """Стрелка по ломаной: линия толщиной w и треугольная головка в последней точке."""
    (x1, y1), (x2, y2) = points[-2], points[-1]
    a = math.atan2(y2 - y1, x2 - x1)
    bx, by = x2 - head * 0.9 * math.cos(a), y2 - head * 0.9 * math.sin(a)
    pts = points[:-1] + [(bx, by)]
    line = ' '.join(f'{x:.1f},{y:.1f}' for x, y in pts)
    hx = lambda r, t: (x2 + r * math.cos(a + t), y2 + r * math.sin(a + t))
    p1 = (x2, y2)
    p2 = (bx + head * 0.62 * math.cos(a + math.pi / 2), by + head * 0.62 * math.sin(a + math.pi / 2))
    p3 = (bx + head * 0.62 * math.cos(a - math.pi / 2), by + head * 0.62 * math.sin(a - math.pi / 2))
    tri = ' '.join(f'{x:.1f},{y:.1f}' for x, y in (p1, p2, p3))
    return (f'<polyline points="{line}" fill="none" stroke="{color}" stroke-width="{w}" stroke-linejoin="round"/>'
            f'<polygon points="{tri}" fill="{color}"/>')


def arc_pts(cx, cy, r, a0, a1, n=10):
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / n)), cy + r * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]


# ---------------------------------------------------------------- пиктограммы 100×100

def car(c=BLACK):
    return (f'<path d="M6,64 L12,48 Q16,38 28,37 L62,37 Q72,37 79,46 L86,55 Q95,57 95,64 L95,70 L6,70 Z" fill="{c}"/>'
            f'<path d="M30,42 L46,42 L46,52 L22,52 Q24,44 30,42 Z M51,42 L63,42 Q69,43 74,52 L51,52 Z" fill="{WHITE}"/>'
            f'<circle cx="27" cy="71" r="10" fill="{c}" stroke="{WHITE}" stroke-width="3"/>'
            f'<circle cx="75" cy="71" r="10" fill="{c}" stroke="{WHITE}" stroke-width="3"/>')


def car_front(c=BLACK):
    return (f'<path d="M22,40 L30,22 L70,22 L78,40 L86,42 L86,70 L14,70 L14,42 Z" fill="{c}"/>'
            f'<path d="M33,27 L67,27 L73,40 L27,40 Z" fill="{WHITE}"/>'
            f'<rect x="14" y="70" width="14" height="10" fill="{c}"/><rect x="72" y="70" width="14" height="10" fill="{c}"/>'
            f'<circle cx="26" cy="52" r="5" fill="{WHITE}"/><circle cx="74" cy="52" r="5" fill="{WHITE}"/>')


def truck(c=BLACK):
    return (f'<rect x="4" y="28" width="58" height="38" fill="{c}"/>'
            f'<path d="M64,38 L82,38 L95,54 L95,66 L64,66 Z" fill="{c}"/><path d="M70,42 L80,42 L88,53 L70,53 Z" fill="{WHITE}"/>'
            f'<circle cx="20" cy="70" r="9" fill="{c}" stroke="{WHITE}" stroke-width="3"/>'
            f'<circle cx="80" cy="70" r="9" fill="{c}" stroke="{WHITE}" stroke-width="3"/>')


def truck_front(c=BLACK):
    return (f'<rect x="16" y="14" width="68" height="60" rx="4" fill="{c}"/><rect x="24" y="22" width="52" height="20" fill="{WHITE}"/>'
            f'<rect x="16" y="74" width="14" height="10" fill="{c}"/><rect x="70" y="74" width="14" height="10" fill="{c}"/>')


def bus(c=BLACK):
    win = ''.join(f'<rect x="{x}" y="36" width="12" height="12" fill="{WHITE}"/>' for x in (12, 28, 44, 60))
    return (f'<rect x="4" y="28" width="90" height="40" rx="6" fill="{c}"/>{win}<rect x="78" y="36" width="10" height="22" fill="{WHITE}"/>'
            f'<circle cx="22" cy="70" r="9" fill="{c}" stroke="{WHITE}" stroke-width="3"/><circle cx="74" cy="70" r="9" fill="{c}" stroke="{WHITE}" stroke-width="3"/>')


def tram(c=BLACK):
    return (f'<path d="M50,6 L36,22 M50,6 L64,22" stroke="{c}" stroke-width="4" fill="none"/>'
            f'<rect x="14" y="24" width="72" height="54" rx="8" fill="{c}"/><rect x="22" y="32" width="56" height="20" fill="{WHITE}"/>'
            f'<rect x="10" y="84" width="80" height="6" fill="{c}"/>')


def moto(c=BLACK):
    return (f'<circle cx="20" cy="66" r="14" fill="none" stroke="{c}" stroke-width="7"/>'
            f'<circle cx="80" cy="66" r="14" fill="none" stroke="{c}" stroke-width="7"/>'
            f'<path d="M20,66 L42,46 L66,46 L80,66 M66,46 L72,32 L84,30 M38,44 L58,40" stroke="{c}" stroke-width="7" fill="none" stroke-linecap="round"/>'
            f'<circle cx="52" cy="22" r="8" fill="{c}"/><path d="M50,30 L56,44 L44,48" stroke="{c}" stroke-width="7" fill="none" stroke-linecap="round"/>')


def bicycle(c=BLACK):
    return (f'<circle cx="22" cy="64" r="17" fill="none" stroke="{c}" stroke-width="6"/>'
            f'<circle cx="78" cy="64" r="17" fill="none" stroke="{c}" stroke-width="6"/>'
            f'<path d="M22,64 L40,38 L68,38 L78,64 M40,38 L50,64 L22,64 M50,64 L68,38 M36,30 L48,30 M64,38 L62,26 L72,26" '
            f'stroke="{c}" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>')


def pedestrian(c=BLACK):
    return (f'<circle cx="52" cy="12" r="9" fill="{c}"/>'
            f'<path d="M50,26 L46,54 M48,32 L34,46 M50,32 L64,44 M46,54 L34,86 M46,54 L60,70 L62,88" '
            f'stroke="{c}" stroke-width="10" fill="none" stroke-linecap="round" stroke-linejoin="round"/>')


def children(c=BLACK):
    one = lambda: pedestrian(c)
    return place(one(), 34, 56, 80) + place(one(), 70, 62, 66)


def tractor(c=BLACK):
    return (f'<circle cx="28" cy="62" r="22" fill="none" stroke="{c}" stroke-width="8"/>'
            f'<circle cx="80" cy="72" r="11" fill="none" stroke="{c}" stroke-width="7"/>'
            f'<path d="M20,36 L20,14 L46,14 L50,40 L86,42 L88,60" stroke="{c}" stroke-width="8" fill="none" stroke-linejoin="round"/>'
            f'<rect x="46" y="40" width="40" height="18" fill="{c}"/>')


def trailer(c=BLACK):
    return (place(car(c), 30, 52, 58) + f'<rect x="64" y="40" width="32" height="22" fill="{c}"/>'
            f'<path d="M56,58 L64,56" stroke="{c}" stroke-width="4"/><circle cx="80" cy="66" r="6" fill="{c}"/>')


def horse_cart(c=BLACK):
    return (f'<path d="M40,30 L60,26 L74,14 L82,16 L80,26 L72,34 L72,50 L40,52 Z" fill="{c}"/>'
            f'<path d="M44,50 L42,76 M52,50 L54,76 M66,50 L64,76 M72,48 L76,76" stroke="{c}" stroke-width="5"/>'
            f'<path d="M40,36 L30,40" stroke="{c}" stroke-width="4"/><path d="M4,46 L34,46" stroke="{c}" stroke-width="5"/>'
            f'<circle cx="18" cy="64" r="13" fill="none" stroke="{c}" stroke-width="5"/>')


def scooter(c=BLACK):
    return (f'<circle cx="20" cy="76" r="9" fill="none" stroke="{c}" stroke-width="6"/><circle cx="80" cy="76" r="9" fill="none" stroke="{c}" stroke-width="6"/>'
            f'<path d="M20,76 L70,76 L80,76 M70,76 L76,18 L66,16" stroke="{c}" stroke-width="7" fill="none" stroke-linecap="round"/>')


def horn(c=BLACK):
    return f'<path d="M14,38 L34,38 L76,14 L76,86 L34,62 L14,62 Z" fill="{c}"/><path d="M84,34 Q94,50 84,66" stroke="{c}" stroke-width="5" fill="none"/>'


def locomotive(c=BLACK):
    return (f'<rect x="8" y="34" width="62" height="30" fill="{c}"/><rect x="70" y="20" width="22" height="44" fill="{c}"/>'
            f'<rect x="20" y="20" width="10" height="14" fill="{c}"/><rect x="75" y="26" width="12" height="12" fill="{WHITE}"/>'
            + ''.join(f'<circle cx="{x}" cy="70" r="8" fill="{c}" stroke="{WHITE}" stroke-width="2"/>' for x in (20, 42, 64, 84)))


def fence(c=BLACK):
    return (f'<rect x="6" y="40" width="88" height="22" fill="{c}"/>'
            + ''.join(f'<rect x="{x}" y="40" width="10" height="22" fill="{WHITE}"/>' for x in (18, 42, 66))
            + f'<rect x="12" y="62" width="8" height="30" fill="{c}"/><rect x="80" y="62" width="8" height="30" fill="{c}"/>')


def traffic_light():
    return (f'<rect x="32" y="4" width="36" height="92" rx="8" fill="{BLACK}"/>'
            f'<circle cx="50" cy="22" r="11" fill="{RED}"/><circle cx="50" cy="50" r="11" fill="{YELLOW}"/><circle cx="50" cy="78" r="11" fill="{GREEN}"/>')


def worker(c=BLACK):
    return (f'<circle cx="62" cy="16" r="9" fill="{c}"/><path d="M58,28 L48,58 L36,90 M48,58 L60,90 M56,34 L30,52" stroke="{c}" stroke-width="10" fill="none" stroke-linecap="round"/>'
            f'<path d="M30,52 L18,76" stroke="{c}" stroke-width="5"/><path d="M8,90 L30,74 L44,90 Z" fill="{c}"/>')


def cow(c=BLACK):
    return (f'<path d="M14,34 L70,34 L84,24 L94,30 L88,44 L80,46 L78,62 L14,62 Z" fill="{c}"/>'
            + ''.join(f'<rect x="{x}" y="62" width="7" height="24" fill="{c}"/>' for x in (18, 30, 62, 72)))


def deer(c=BLACK):
    return (f'<path d="M12,46 Q14,36 30,36 L64,36 L72,22 L80,20 L84,28 L76,44 L72,60 L16,60 Z" fill="{c}"/>'
            f'<path d="M76,20 L70,6 M76,20 L86,8 M72,14 L64,10 M82,12 L92,10" stroke="{c}" stroke-width="4"/>'
            + ''.join(f'<path d="M{x},60 L{x + d},88" stroke="{c}" stroke-width="6"/>' for x, d in ((22, -6), (32, 4), (60, -4), (70, 6))))


def rocks(c=BLACK):
    return (f'<path d="M8,10 L30,10 L30,92 L8,92 Z" fill="{c}"/>'
            f'<circle cx="52" cy="32" r="8" fill="{c}"/><circle cx="66" cy="52" r="10" fill="{c}"/><circle cx="56" cy="80" r="12" fill="{c}"/>'
            f'<path d="M30,92 L94,92" stroke="{c}" stroke-width="6"/>')


def plane(c=BLACK):
    return (f'<path d="M50,6 Q56,6 56,20 L56,40 L92,58 L92,66 L56,56 L56,78 L66,86 L66,92 L50,88 L34,92 L34,86 L44,78 L44,56 L8,66 L8,58 L44,40 L44,20 Q44,6 50,6 Z" fill="{c}"/>')


def windsock(c=BLACK):
    return f'<path d="M14,10 L14,92" stroke="{c}" stroke-width="7"/><path d="M14,18 L88,30 L88,48 L14,52 Z" fill="{c}"/>'


def gravel(c=BLACK):
    return (place(car(c), 64, 64, 66)
            + ''.join(f'<circle cx="{x}" cy="{y}" r="4" fill="{c}"/>' for x, y in ((14, 70), (20, 58), (26, 46), (12, 46), (24, 30), (34, 62))))


def bump(c=BLACK):
    return f'<path d="M4,78 L26,78 Q50,30 74,78 L96,78 L96,86 L4,86 Z" fill="{c}"/>'


def uneven(c=BLACK):
    return f'<path d="M4,80 Q16,54 28,78 Q40,92 52,74 Q64,56 76,76 Q88,92 96,78 L96,90 L4,90 Z" fill="{c}"/>'


def slippery(c=BLACK):
    return (place(car(c), 56, 34, 62)
            + f'<path d="M30,96 Q14,80 34,70 Q50,62 40,50" stroke="{c}" stroke-width="6" fill="none"/>'
            f'<path d="M66,96 Q50,80 70,70 Q86,62 76,50" stroke="{c}" stroke-width="6" fill="none"/>')


def tunnel(c=BLACK):
    return f'<path d="M6,92 L6,48 Q6,10 50,10 Q94,10 94,48 L94,92 L72,92 L72,52 Q72,32 50,32 Q28,32 28,52 L28,92 Z" fill="{c}"/>'


def jam(c=BLACK):
    return place(car_front(c), 50, 26, 46) + place(car_front(c), 26, 70, 46) + place(car_front(c), 74, 70, 46)


def bridge(c=BLACK):
    return (f'<path d="M4,62 L36,62 L36,26 L44,26 L44,62 L56,62 L56,26 L64,26 L64,62 L96,62 L96,72 L4,72 Z" fill="{c}"/>'
            f'<path d="M4,86 Q50,74 96,86" stroke="{c}" stroke-width="6" fill="none"/>')


def quay(c=BLACK):
    return (place(car(c), 40, 36, 60) + f'<path d="M4,62 L66,62 L66,96 L4,96 Z" fill="{c}"/>'
            f'<path d="M70,74 Q78,68 86,74 Q94,80 98,74 M70,88 Q78,82 86,88 Q94,94 98,88" stroke="{c}" stroke-width="4" fill="none"/>')


def steep(c=BLACK, up=False):
    t = '<path d="M6,90 L94,90 L94,24 Z" fill="{c}"/>'.format(c=c) if not up else '<path d="M6,90 L94,90 L6,24 Z" fill="{c}"/>'.format(c=c)
    return t + text(64 if not up else 36, 74, '10%', 22, WHITE)


def narrowing(which):
    l = '<path d="M30,96 L30,58 L44,36 L44,4" stroke="{c}" stroke-width="10" fill="none"/>'
    r = '<path d="M70,96 L70,58 L56,36 L56,4" stroke="{c}" stroke-width="10" fill="none"/>'
    ls = '<path d="M30,96 L30,4" stroke="{c}" stroke-width="10"/>'
    rs = '<path d="M70,96 L70,4" stroke="{c}" stroke-width="10"/>'
    body = {'both': l + r, 'right': ls.replace('M30', 'M38').replace('L30', 'L38') + r, 'left': l + rs.replace('M70', 'M62').replace('L70', 'L62')}[which]
    return body.format(c=BLACK)


def two_way(c=BLACK):
    return arrow([(32, 92), (32, 14)], c, 12, 30) + arrow([(68, 8), (68, 86)], c, 12, 30)


def bends(first_right=True, double=False):
    pts = [(40, 94), (40, 56)] + arc_pts(62, 56, 22, 180, 270, 6) + [(66, 34), (66, 8)] if False else None
    if double:
        p = [(36, 96), (36, 70), (64, 52), (64, 34), (40, 18), (40, 4)]
    else:
        p = [(38, 96), (38, 54)] + arc_pts(64, 54, 26, 180, 270, 6) + [(90, 28)]
    if not first_right:
        p = [(100 - x, y) for x, y in p]
    return arrow(p, BLACK, 12, 30) if not double else f'<polyline points="{" ".join(f"{x},{y}" for x, y in p)}" fill="none" stroke="{BLACK}" stroke-width="12" stroke-linejoin="round"/>'


def crosswalk_ped(c=BLACK):
    return (place(pedestrian(c), 52, 42, 72)
            + ''.join(f'<rect x="{x}" y="82" width="12" height="12" fill="{c}"/>' for x in (6, 30, 54, 78)))


def bike_path_cross(c=BLACK):
    return bicycle(c)


def roadworks():
    return worker()


def chevron(direction):
    """Знаки 1.34: красное поле со стрелками-шевронами."""
    pts = lambda x: f'{x},40 {x + 22},100 {x},160 {x + 18},160 {x + 40},100 {x + 18},40'
    chev = ''.join(f'<polygon points="{pts(x)}" fill="{WHITE}"/>' for x in (34, 82, 130))
    if direction == 'left':
        chev = f'<g transform="translate(200,0) scale(-1,1)">{chev}</g>'
    if direction == 'both':
        left = ''.join(f'<polygon points="{pts(x)}" fill="{WHITE}"/>' for x in (112, 150))
        right = ''.join(f'<polygon points="{pts(x)}" fill="{WHITE}"/>' for x in (112, 150))
        chev = f'<g transform="translate(200,0) scale(-1,1)">{left}</g>' + right.replace('112', '112')
        chev = (f'<g transform="translate(200,0) scale(-1,1)">' + ''.join(f'<polygon points="{pts(x)}" fill="{WHITE}"/>' for x in (106, 146)) + '</g>'
                + ''.join(f'<polygon points="{pts(x)}" fill="{WHITE}"/>' for x in (106, 146)))
    return f'<rect x="4" y="30" width="192" height="140" fill="{RED}"/>{chev}'


# ---------------------------------------------------------------- формы

def warning(pic, inv=False):
    if inv:
        return f'<polygon points="12,22 188,22 100,184" fill="{WHITE}" stroke="{RED}" stroke-width="16" stroke-linejoin="round"/>' + pic
    return f'<polygon points="100,14 188,172 12,172" fill="{WHITE}" stroke="{RED}" stroke-width="16" stroke-linejoin="round"/>' + pic


def warn(pic, size=76, cy=120):
    return 200, 200, warning(place(pic, 100, cy, size))


def prohibit(pic='', bg=WHITE, slash=False, end=False):
    if end:
        ring = f'<circle cx="100" cy="100" r="94" fill="{WHITE}" stroke="{BLACK}" stroke-width="3"/>'
        lines = ''.join(f'<line x1="{40 + d}" y1="{168 + d * 0}" x2="{160 + d}" y2="{32}" stroke="{BLACK}" stroke-width="4" transform="translate({d * 0},{0})"/>' for d in (-10, 0, 10))
        lines = ''.join(f'<line x1="{38 + d}" y1="{162 + d}" x2="{162 + d}" y2="{38 + d}" stroke="{BLACK}" stroke-width="4"/>' for d in (-12, 0, 12))
        return 200, 200, ring + recolor(pic, GREY) + lines
    body = f'<circle cx="100" cy="100" r="88" fill="{bg}" stroke="{RED}" stroke-width="20"/>' + pic
    if slash:
        body += f'<line x1="38" y1="162" x2="162" y2="38" stroke="{RED}" stroke-width="16"/>'
    return 200, 200, body


def mandatory(pic, slash=False):
    body = f'<circle cx="100" cy="100" r="96" fill="{BLUE}"/>' + pic
    if slash:
        body += f'<line x1="38" y1="162" x2="162" y2="38" stroke="{RED}" stroke-width="14"/>'
    return 200, 200, body


def square(pic, slash=False, inner_white=False):
    body = f'<rect x="4" y="4" width="192" height="192" rx="12" fill="{BLUE}"/>'
    if inner_white:
        body += f'<rect x="28" y="28" width="144" height="144" rx="6" fill="{WHITE}"/>'
    body += pic
    if slash:
        body += f'<line x1="22" y1="178" x2="178" y2="22" stroke="{RED}" stroke-width="14"/>'
    return 200, 200, body


def white_plate(w, h, pic, border=True):
    return w, h, (f'<rect x="3" y="3" width="{w - 6}" height="{h - 6}" rx="8" fill="{WHITE}" stroke="{BLACK}" stroke-width="5"/>' if border else '') + pic


def zone(inner, end=False):
    """Знаки «Зона …»: белая табличка, слово ЗОНА и вписанный знак."""
    body = f'<rect x="4" y="4" width="192" height="232" rx="10" fill="{WHITE}" stroke="{BLACK}" stroke-width="4"/>'
    body += text(100, 34, 'ЗОНА', 34) + f'<g transform="translate(30,62) scale(0.7)">{inner}</g>'
    if end:
        body = recolor(body, GREY).replace(f'stroke="{GREY}" stroke-width="4"', f'stroke="{BLACK}" stroke-width="4"')
        body += ''.join(f'<line x1="{20 + d}" y1="{220 + d}" x2="{180 + d}" y2="{20 + d}" stroke="{BLACK}" stroke-width="4"/>' for d in (-14, 0, 14))
    return 200, 240, body


# ---------------------------------------------------------------- стрелки предписывающих знаков (поле 200×200)

def up(c=WHITE):
    return arrow([(100, 170), (100, 34)], c, 26, 56)


def turn(side, c=WHITE, x0=88):
    s = 1 if side == 'right' else -1
    pts = [(100 - s * 22, 172), (100 - s * 22, 112)] + [(100 - s * 22 + s * 40 * (1 - math.cos(t)), 112 - 40 * math.sin(t)) for t in [i * math.pi / 2 / 6 for i in range(1, 7)]] + [(100 + s * 66, 72)]
    return arrow(pts, c, 24, 52)


def straight_or(side, c=WHITE):
    s = 1 if side == 'right' else -1
    x = 100 - s * 26
    branch = [(x, 128)] + [(x + s * 34 * (1 - math.cos(t)), 128 - 34 * math.sin(t)) for t in [i * math.pi / 2 / 5 for i in range(1, 6)]] + [(x + s * 80, 94)]
    return arrow([(x, 176), (x, 36)], c, 22, 48) + arrow(branch, c, 22, 44)


def left_or_right(c=WHITE):
    stem = f'<line x1="100" y1="178" x2="100" y2="104" stroke="{c}" stroke-width="22"/>'
    l = [(100, 112)] + [(100 - 34 * (1 - math.cos(t)), 112 - 34 * math.sin(t)) for t in [i * math.pi / 2 / 5 for i in range(1, 6)]] + [(26, 78)]
    r = [(x if i == 0 else 200 - x, y) for i, (x, y) in enumerate(l)]
    return stem + arrow(l, c, 22, 44) + arrow(r, c, 22, 44)


def uturn(c=BLACK, w=22):
    pts = [(124, 172), (124, 92)] + [(100 + 24 * math.cos(math.radians(a)), 92 - 24 * math.sin(math.radians(a))) for a in range(0, 181, 20)] + [(76, 150)]
    return arrow(pts, c, w, 46)


def lane_arrows(spec, c=WHITE):
    """Набор стрелок по полосам: spec — строка из s (прямо), r, l, sr, sl."""
    out, n = '', len(spec)
    for i, k in enumerate(spec):
        cx = 46 + (108 / max(1, n - 1)) * i if n > 1 else 100
        g = {'s': up(c), 'r': turn('right', c), 'l': turn('left', c), 'sr': straight_or('right', c), 'sl': straight_or('left', c)}[k]
        out += f'<g transform="translate({cx:.1f},100) scale(0.4,0.8) translate(-100,-100)">{g}</g>'
    return out


# ---------------------------------------------------------------- знаки

def draw(sid):  # noqa: C901 — таблица знаков
    W = WHITE
    # 1. Предупреждающие
    if sid == '1.1':
        return warn(fence())
    if sid == '1.2':
        return warn(locomotive())
    if sid in ('1.3.1', '1.3.2'):
        bar = lambda y: f'<rect x="10" y="{y}" width="180" height="22" fill="{W}" stroke="{RED}" stroke-width="7"/>'
        cross = f'<g transform="rotate(45,100,100)">{bar(89)}</g><g transform="rotate(-45,100,100)">{bar(89)}</g>'
        if sid == '1.3.2':
            cross += f'<g transform="translate(0,58)"><g transform="rotate(45,100,100)">{bar(89).replace("width=\"180\"", "width=\"60\"").replace("x=\"10\"", "x=\"70\"")}</g><g transform="rotate(-45,100,100)">{bar(89).replace("width=\"180\"", "width=\"60\"").replace("x=\"10\"", "x=\"70\"")}</g></g>'
        return 200, 200, cross
    if sid.startswith('1.4.'):
        n = {'1.4.1': 3, '1.4.2': 3, '1.4.3': 2, '1.4.4': 2, '1.4.5': 1, '1.4.6': 1}[sid]
        stripes = ''.join(f'<polygon points="20,{y} 80,{y - 22} 80,{y + 4} 20,{y + 26}" fill="{RED}"/>' for y in [40 + 50 * i for i in range(n)][::-1])
        if sid in ('1.4.2', '1.4.4', '1.4.6'):
            stripes = f'<g transform="translate(100,0) scale(-1,1)">{stripes}</g>'
        return 100, 200, f'<rect x="4" y="4" width="92" height="192" fill="{W}" stroke="{BLACK}" stroke-width="2"/>' + stripes
    if sid == '1.5':
        return warn(tram())
    if sid == '1.6':
        return warn(f'<path d="M50,4 L50,96 M4,50 L96,50" stroke="{BLACK}" stroke-width="14"/>', 70)
    if sid == '1.7':
        ring = ''.join(arrow(arc_pts(50, 52, 30, a, a + 90, 6), BLACK, 9, 20) for a in (0, 120, 240))
        return warn(ring, 74)
    if sid == '1.8':
        return warn(traffic_light(), 66, 118)
    if sid == '1.9':
        return warn(f'<path d="M6,80 L44,80 L44,72 L20,40 L30,34 L54,72 L54,80 M60,80 L94,80" stroke="{BLACK}" stroke-width="9" fill="none"/>' + f'<path d="M4,92 Q50,82 96,92" stroke="{BLACK}" stroke-width="5" fill="none"/>')
    if sid == '1.10':
        return warn(quay())
    if sid in ('1.11.1', '1.11.2'):
        return warn(bends(sid == '1.11.1'), 74)
    if sid in ('1.12.1', '1.12.2'):
        p = [(30, 96), (30, 74), (64, 54), (64, 40), (36, 22)]
        if sid == '1.12.2':
            p = [(100 - x, y) for x, y in p]
        return warn(arrow(p, BLACK, 11, 26), 76)
    if sid == '1.13':
        return warn(steep(BLACK), 74, 124)
    if sid == '1.14':
        return warn(steep(BLACK, up=True), 74, 124)
    if sid == '1.15':
        return warn(slippery(), 80)
    if sid == '1.16':
        return warn(uneven(), 74, 126)
    if sid == '1.17':
        return warn(bump(), 74, 126)
    if sid == '1.18':
        return warn(gravel(), 76)
    if sid == '1.19':
        return warn(place(car(), 40, 40, 60) + f'<path d="M4,62 L60,62 L96,94 L4,94 Z" fill="{BLACK}"/>', 74)
    if sid == '1.20.1':
        return warn(narrowing('both'), 70)
    if sid == '1.20.2':
        return warn(narrowing('right'), 70)
    if sid == '1.20.3':
        return warn(narrowing('left'), 70)
    if sid == '1.21':
        return warn(two_way(), 70)
    if sid == '1.22':
        return warn(crosswalk_ped(), 74)
    if sid == '1.23':
        return warn(children(), 80)
    if sid == '1.24':
        return warn(bicycle(), 76, 124)
    if sid == '1.25':
        return warn(worker(), 76)
    if sid == '1.26':
        return warn(cow(), 76)
    if sid == '1.27':
        return warn(deer(), 76)
    if sid == '1.28':
        return warn(rocks(), 74)
    if sid == '1.29':
        return warn(windsock(), 72)
    if sid == '1.30':
        return warn(plane(), 74)
    if sid == '1.31':
        return warn(tunnel(), 72, 124)
    if sid == '1.32':
        return warn(jam(), 74)
    if sid == '1.33':
        return 200, 200, warning(f'<rect x="91" y="72" width="18" height="58" rx="4" fill="{BLACK}"/><circle cx="100" cy="148" r="10" fill="{BLACK}"/>')
    if sid == '1.34.1':
        return 200, 200, chevron('right')
    if sid == '1.34.2':
        return 200, 200, chevron('left')
    if sid == '1.34.3':
        return 200, 200, chevron('both')
    if sid == '1.35':
        grid = f'<rect x="38" y="82" width="124" height="74" fill="{YELLOW}"/>' + ''.join(f'<line x1="{x}" y1="82" x2="{x - 40}" y2="156" stroke="{BLACK}" stroke-width="5"/>' for x in (80, 110, 140, 170, 200))
        return 200, 200, f'<clipPath id="c135"><polygon points="100,58 156,160 44,160"/></clipPath>' + warning(f'<g clip-path="url(#c135)">{grid}</g>')

    # 2. Приоритета
    if sid in ('2.1', '2.2'):
        body = (f'<polygon points="100,4 196,100 100,196 4,100" fill="{W}" stroke="{BLACK}" stroke-width="2"/>'
                f'<polygon points="100,26 174,100 100,174 26,100" fill="{YELLOW}"/>')
        if sid == '2.2':
            body += ''.join(f'<line x1="{52 + d}" y1="{148 + d}" x2="{148 + d}" y2="{52 + d}" stroke="{BLACK}" stroke-width="6"/>' for d in (-14, 0, 14))
        return 200, 200, body
    if sid.startswith('2.3.'):
        main = f'<rect x="88" y="62" width="24" height="96" fill="{BLACK}"/>'
        side = {'2.3.1': f'<rect x="52" y="106" width="96" height="12" fill="{BLACK}"/>',
                '2.3.2': f'<rect x="100" y="106" width="48" height="12" fill="{BLACK}"/>',
                '2.3.3': f'<rect x="52" y="106" width="48" height="12" fill="{BLACK}"/>',
                '2.3.4': f'<rect x="100" y="132" width="48" height="12" fill="{BLACK}"/>',
                '2.3.5': f'<rect x="52" y="132" width="48" height="12" fill="{BLACK}"/>',
                '2.3.6': f'<rect x="100" y="80" width="48" height="12" fill="{BLACK}"/>',
                '2.3.7': f'<rect x="52" y="80" width="48" height="12" fill="{BLACK}"/>'}[sid]
        return 200, 200, warning(main + side)
    if sid == '2.4':
        return 200, 200, warning('', inv=True)
    if sid == '2.5':
        pts = ' '.join(f'{100 + 94 * math.cos(a):.1f},{100 + 94 * math.sin(a):.1f}' for a in [k * math.pi / 4 + math.pi / 8 for k in range(8)])
        return 200, 200, f'<polygon points="{pts}" fill="{RED}" stroke="{W}" stroke-width="6"/>' + text(100, 102, 'STOP', 52, W)
    if sid == '2.6':
        return prohibit(arrow([(118, 160), (118, 40)], RED, 18, 40) + arrow([(82, 40), (82, 160)], BLACK, 18, 40))
    if sid == '2.7':
        return square(arrow([(124, 170), (124, 32)], W, 22, 48) + arrow([(76, 32), (76, 170)], RED, 22, 48))

    # 3. Запрещающие
    simple3 = {'3.3': (place(car(), 100, 74, 92) + place(moto(), 100, 128, 72)), '3.4': place(truck(), 100, 100, 120), '3.5': place(moto(), 100, 100, 112),
               '3.6': place(tractor(), 100, 100, 112), '3.7': place(trailer(), 100, 100, 124), '3.8': place(horse_cart(), 100, 100, 118),
               '3.9': place(bicycle(), 100, 100, 116), '3.10': place(pedestrian(), 100, 98, 110), '3.34': place(bus(), 100, 100, 120),
               '3.35': place(scooter(), 100, 98, 104),
               '3.32': place(truck(), 100, 92, 112) + f'<rect x="82" y="134" width="36" height="20" fill="{ORANGE}" stroke="{BLACK}" stroke-width="3"/>',
               '3.33': place(truck(), 100, 92, 112) + f'<polygon points="100,128 108,144 124,140 112,152 120,166 100,158 80,166 88,152 76,140 92,144" fill="{BLACK}"/>'}
    if sid in simple3:
        return prohibit(simple3[sid])
    if sid == '3.1':
        return 200, 200, f'<circle cx="100" cy="100" r="96" fill="{RED}"/><rect x="28" y="84" width="144" height="32" fill="{W}"/>'
    if sid == '3.2':
        return prohibit()
    if sid in ('3.11', '3.12', '3.13', '3.14', '3.15', '3.16', '3.24', '4.6'):
        val = {'3.11': '7т', '3.12': '6т', '3.13': '3.5м', '3.14': '2.7м', '3.15': '10м', '3.16': '50м', '3.24': '40', '4.6': '40'}[sid]
        if sid == '4.6':
            return mandatory(text(100, 102, val, 84, W))
        extra = ''
        if sid == '3.12':
            extra = f'<rect x="70" y="136" width="60" height="8" fill="{BLACK}"/><circle cx="76" cy="148" r="8" fill="{BLACK}"/><circle cx="124" cy="148" r="8" fill="{BLACK}"/>'
        if sid == '3.13':
            extra = f'<polygon points="80,36 120,36 100,56" fill="{BLACK}"/><polygon points="80,164 120,164 100,144" fill="{BLACK}"/>'
        if sid == '3.14':
            extra = f'<polygon points="36,80 36,120 56,100" fill="{BLACK}"/><polygon points="164,80 164,120 144,100" fill="{BLACK}"/>'
        if sid == '3.15':
            extra = arrow([(70, 140), (40, 140)], BLACK, 5, 14) + arrow([(130, 140), (160, 140)], BLACK, 5, 14)
        if sid == '3.16':
            extra = place(truck(), 70, 58, 46) + place(car(), 132, 58, 40)
        size = 64 if len(val) <= 2 else 50
        return prohibit(text(100, 104 if sid != '3.16' else 120, val, size) + extra)
    if sid == '3.17.1':
        return prohibit(text(100, 100, 'ТАМОЖНЯ', 26))
    if sid == '3.17.2':
        return prohibit(f'<rect x="30" y="88" width="140" height="24" fill="{RED}"/>')
    if sid == '3.17.3':
        return prohibit(text(100, 100, 'КОНТРОЛЬ', 24))
    if sid == '3.18.1':
        return prohibit(shrink(turn('right', BLACK), 0.62, 100, 104), slash=True)
    if sid == '3.18.2':
        return prohibit(shrink(turn('left', BLACK), 0.62, 100, 104), slash=True)
    if sid == '3.19':
        return prohibit(shrink(uturn(BLACK), 0.7, 100, 104), slash=True)
    if sid in ('3.20', '3.21'):
        pic = place(car_front(RED if sid == '3.20' else BLACK), 66, 100, 70) + place(car_front(), 134, 100, 70)
        return prohibit(pic, end=(sid == '3.21'))
    if sid in ('3.22', '3.23'):
        pic = place(truck_front(RED if sid == '3.22' else BLACK), 66, 100, 70) + place(car_front(), 134, 100, 70)
        return prohibit(pic, end=(sid == '3.23'))
    if sid == '3.25':
        return prohibit(text(100, 104, '40', 64), end=True)
    if sid == '3.26':
        return prohibit(place(horn(), 100, 100, 110), slash=True)
    if sid == '3.27':
        return 200, 200, (f'<circle cx="100" cy="100" r="88" fill="{BLUE}" stroke="{RED}" stroke-width="20"/>'
                          f'<line x1="40" y1="40" x2="160" y2="160" stroke="{RED}" stroke-width="18"/><line x1="160" y1="40" x2="40" y2="160" stroke="{RED}" stroke-width="18"/>')
    if sid in ('3.28', '3.29', '3.30'):
        body = f'<circle cx="100" cy="100" r="88" fill="{BLUE}" stroke="{RED}" stroke-width="20"/><line x1="40" y1="40" x2="160" y2="160" stroke="{RED}" stroke-width="18"/>'
        if sid == '3.29':
            body += f'<rect x="64" y="70" width="12" height="60" fill="{W}"/>'
        if sid == '3.30':
            body += f'<rect x="56" y="70" width="12" height="60" fill="{W}"/><rect x="76" y="70" width="12" height="60" fill="{W}"/>'
        return 200, 200, body
    if sid == '3.31':
        return prohibit('', end=True)

    # 4. Предписывающие
    if sid == '4.1.1':
        return mandatory(up())
    if sid == '4.1.2':
        return mandatory(turn('right'))
    if sid == '4.1.3':
        return mandatory(turn('left'))
    if sid == '4.1.4':
        return mandatory(straight_or('right'))
    if sid == '4.1.5':
        return mandatory(straight_or('left'))
    if sid == '4.1.6':
        return mandatory(left_or_right())
    if sid == '4.2.1':
        return mandatory(arrow([(66, 56), (140, 146)], W, 24, 52))
    if sid == '4.2.2':
        return mandatory(arrow([(134, 56), (60, 146)], W, 24, 52))
    if sid == '4.2.3':
        return mandatory(arrow([(100, 70), (56, 150)], W, 22, 46) + arrow([(100, 70), (144, 150)], W, 22, 46))
    if sid == '4.3':
        return mandatory(''.join(arrow(arc_pts(100, 100, 56, a + 10, a + 100, 8), W, 20, 42) for a in (0, 120, 240)))
    if sid in ('4.4.1', '4.4.2'):
        return mandatory(place(bicycle(W), 100, 100, 130), slash=sid == '4.4.2')
    if sid == '4.5.1':
        return mandatory(place(pedestrian(W), 100, 100, 120))
    if sid in ('4.5.2', '4.5.3'):
        pic = place(pedestrian(W), 100, 62, 66) + f'<rect x="20" y="96" width="160" height="8" fill="{W}"/>' + place(bicycle(W), 100, 140, 74)
        return mandatory(pic, slash=sid == '4.5.3')
    if sid in ('4.5.4', '4.5.5', '4.5.6', '4.5.7'):
        left, right = (pedestrian(W), bicycle(W)) if sid in ('4.5.4', '4.5.6') else (bicycle(W), pedestrian(W))
        pic = place(left, 62, 100, 70) + f'<rect x="96" y="20" width="8" height="160" fill="{W}"/>' + place(right, 138, 100, 70)
        return mandatory(pic, slash=sid in ('4.5.6', '4.5.7'))
    if sid == '4.7':
        return mandatory(text(100, 102, '40', 84, W), slash=True)
    if sid in ('4.8.1', '4.8.2', '4.8.3'):
        tr = place(truck(W), 100, 70, 90) + f'<rect x="88" y="104" width="24" height="14" fill="{ORANGE}"/>'
        ar = {'4.8.1': arrow([(100, 180), (100, 128)], W, 14, 30), '4.8.2': arrow([(70, 150), (140, 150)], W, 14, 30), '4.8.3': arrow([(130, 150), (60, 150)], W, 14, 30)}[sid]
        return mandatory(tr + ar)

    # 5. Особых предписаний
    if sid in ('5.1', '5.2'):
        return square(place(bridge(W), 100, 100, 150), slash=sid == '5.2')
    if sid in ('5.3', '5.4'):
        return square(place(car(W), 100, 100, 150), slash=sid == '5.4')
    if sid in ('5.5', '5.6'):
        return square(arrow([(100, 172), (100, 30)], W, 30, 64), slash=sid == '5.6')
    if sid in ('5.7.1', '5.7.2'):
        body = f'<rect x="4" y="44" width="292" height="112" rx="10" fill="{BLUE}"/>' + arrow([(40, 100), (260, 100)], W, 28, 60)
        if sid == '5.7.2':
            body = f'<g transform="translate(300,0) scale(-1,1)">{body}</g>'
        return 300, 200, body
    if sid in ('5.8', '5.9'):
        return square(arrow([(70, 170), (70, 30)], W, 22, 48) + arrow([(130, 30), (130, 170)], W, 22, 48), slash=sid == '5.9')
    if sid == '5.10':
        return square(arrow([(40, 100), (160, 100)], W, 22, 48) + f'<rect x="150" y="30" width="10" height="140" fill="{W}"/>')
    if sid.startswith('5.11.') or sid.startswith('5.12.'):
        pic = bus(W) if sid.endswith('.1') else bicycle(W)
        lanes = f'<rect x="120" y="20" width="8" height="160" fill="{W}"/>' + arrow([(70, 172), (70, 36)], W, 18, 40)
        return square(lanes + place(pic, 160, 100, 56), slash=sid.startswith('5.12.'))
    if sid.startswith('5.13.'):
        pic = bus(W) if sid in ('5.13.1', '5.13.2') else bicycle(W)
        ar = arrow([(30, 120), (150, 120)], W, 18, 40) if sid in ('5.13.1', '5.13.3') else arrow([(170, 120), (50, 120)], W, 18, 40)
        return square(ar + place(pic, 100, 62, 80))
    if sid.startswith('5.14.'):
        pic = bus(W) if sid in ('5.14.1', '5.14.2') else bicycle(W)
        return square(f'<rect x="60" y="20" width="8" height="160" fill="{W}" stroke-dasharray="0"/>' + place(pic, 130, 100, 90), slash=sid in ('5.14.2', '5.14.4'))
    if sid == '5.15.1':
        return square(lane_arrows(['l', 's', 'sr']))
    if sid == '5.15.2':
        return square(straight_or('right'))
    if sid == '5.15.3':
        return square(arrow([(70, 172), (70, 36)], W, 18, 40) + arrow([(130, 172), (130, 120), (150, 90), (150, 36)], W, 18, 40))
    if sid == '5.15.4':
        return square(arrow([(70, 172), (70, 36)], W, 18, 40) + arrow([(130, 172), (130, 120), (150, 90), (150, 36)], W, 18, 40))
    if sid in ('5.15.5', '5.15.6'):
        return square(arrow([(70, 172), (70, 36)], W, 18, 40) + arrow([(130, 172), (130, 110), (88, 70)], W, 18, 40))
    if sid == '5.15.7':
        return square(arrow([(70, 32), (70, 170)], W, 18, 40) + arrow([(130, 170), (130, 32)], W, 18, 40) + f'<rect x="96" y="20" width="8" height="160" fill="{W}"/>')
    if sid == '5.15.8':
        return square(''.join(arrow([(x, 170), (x, 32)], W, 16, 36) for x in (50, 100, 150)))
    if sid == '5.16':
        return square(place(bus(), 100, 100, 120), inner_white=True)
    if sid == '5.17':
        return square(place(tram(), 100, 100, 110), inner_white=True)
    if sid == '5.18':
        return square(place(car(), 100, 84, 100) + text(100, 146, 'ТАКСИ', 26), inner_white=True)
    if sid in ('5.19.1', '5.19.2'):
        tri = f'<polygon points="100,22 178,170 22,170" fill="{W}"/>'
        pic = place(pedestrian(), 104, 112, 82) + ''.join(f'<rect x="{x}" y="150" width="14" height="10" fill="{BLACK}"/>' for x in (54, 82, 110, 138))
        return square(tri + pic) if sid == '5.19.1' else square(tri + f'<g transform="translate(200,0) scale(-1,1)">{pic}</g>')
    if sid == '5.20':
        return square(f'<polygon points="100,22 178,170 22,170" fill="{W}"/>' + place(bump(), 100, 130, 90))
    if sid in ('5.21', '5.22'):
        house = f'<polygon points="60,70 100,36 140,70" fill="{BLACK}"/><rect x="66" y="70" width="68" height="48" fill="{BLACK}"/><rect x="92" y="88" width="16" height="30" fill="{W}"/>'
        pic = house + place(pedestrian(), 54, 150, 46) + place(children(), 96, 152, 42) + place(car(), 150, 152, 54)
        body = f'<rect x="4" y="4" width="192" height="192" rx="10" fill="{BLUE}"/><rect x="18" y="18" width="164" height="164" rx="4" fill="{W}"/>' + pic
        if sid == '5.22':
            body += f'<line x1="22" y1="178" x2="178" y2="22" stroke="{RED}" stroke-width="14"/>'
        return 200, 200, body
    if sid in ('5.23.1', '5.24.1'):
        body = f'<rect x="4" y="4" width="312" height="132" rx="8" fill="{W}" stroke="{BLACK}" stroke-width="5"/>' + text(160, 70, 'ГОРОД', 56)
        if sid == '5.24.1':
            body += f'<line x1="20" y1="124" x2="300" y2="16" stroke="{RED}" stroke-width="12"/>'
        return 320, 140, body
    if sid in ('5.23.2', '5.24.2'):
        sky = ''.join(f'<rect x="{x}" y="{y}" width="{w}" height="{120 - y}" fill="{BLACK}"/>' for x, y, w in ((40, 70, 30), (74, 40, 26), (104, 56, 34), (142, 30, 22), (168, 64, 36), (208, 50, 26), (238, 74, 34)))
        body = f'<rect x="4" y="4" width="312" height="132" rx="8" fill="{W}" stroke="{BLACK}" stroke-width="5"/>' + sky
        if sid == '5.24.2':
            body += f'<line x1="20" y1="124" x2="300" y2="16" stroke="{RED}" stroke-width="12"/>'
        return 320, 140, body
    if sid in ('5.25', '5.26'):
        body = f'<rect x="4" y="4" width="312" height="132" rx="8" fill="{BLUE}"/>' + text(160, 70, 'Посёлок', 52, W)
        if sid == '5.26':
            body += f'<line x1="20" y1="124" x2="300" y2="16" stroke="{RED}" stroke-width="12"/>'
        return 320, 140, body
    zones = {
        '5.27': draw('3.28'), '5.29': square(text(100, 100, 'P', 140, W)), '5.31': prohibit(text(100, 104, '20', 64)),
        '5.33': mandatory(place(pedestrian(W), 100, 100, 120)), '5.35': prohibit(text(100, 104, '4', 70)),
        '5.37': prohibit(place(truck(), 100, 80, 90) + text(100, 140, '4', 44)), '5.39': mandatory(place(bicycle(W), 100, 100, 130)),
    }
    end_of = {'5.28': '5.27', '5.30': '5.29', '5.32': '5.31', '5.34': '5.33', '5.36': '5.35', '5.38': '5.37', '5.40': '5.39'}
    if sid in zones:
        return zone(zones[sid][2])
    if sid in end_of:
        return zone(zones[end_of[sid]][2], end=True)

    # 6. Информационные (основные)
    if sid == '6.2':
        return square(text(100, 100, '50', 96, W))
    if sid == '6.3.1':
        return square(shrink(uturn(W, 22), 0.9, 100, 100))
    if sid == '6.3.2':
        return 200, 280, (f'<rect x="4" y="4" width="192" height="272" rx="10" fill="{BLUE}"/>' + shrink(uturn(W, 22), 0.8, 100, 96)
                          + arrow([(100, 196), (100, 268)], W, 10, 24).replace('100,196', '100,190') + text(142, 228, '150 м', 30, W))
    if sid == '6.4':
        return square(text(100, 100, 'P', 150, W))
    if sid == '6.5':
        return square(place(car(W), 100, 70, 90) + f'<rect x="40" y="140" width="120" height="10" fill="{W}"/>' + text(100, 168, 'SOS', 26, W))
    if sid in ('6.6', '6.7'):
        stairs = f'<path d="M20,150 L60,150 L60,126 L84,126 L84,102 L108,102 L108,78 L132,78 L132,54 L180,54" stroke="{W}" stroke-width="10" fill="none"/>'
        if sid == '6.6':
            stairs = f'<g transform="translate(0,200) scale(1,-1)">{stairs}</g>'
        return square(stairs + place(pedestrian(W), 100, 100 if sid == '6.7' else 110, 70))
    if sid in ('6.8.1', '6.8.2', '6.8.3'):
        stem = f'<rect x="88" y="70" width="24" height="110" fill="{W}"/><rect x="50" y="40" width="100" height="30" fill="{RED}"/>'
        if sid == '6.8.2':
            stem = f'<rect x="40" y="112" width="110" height="24" fill="{W}"/><rect x="150" y="80" width="30" height="90" fill="{RED}"/>'
        if sid == '6.8.3':
            stem = f'<rect x="50" y="112" width="110" height="24" fill="{W}"/><rect x="20" y="80" width="30" height="90" fill="{RED}"/>'
        return square(stem)
    if sid == '6.13':
        return 140, 200, f'<rect x="4" y="4" width="132" height="192" rx="8" fill="{W}" stroke="{BLACK}" stroke-width="5"/>' + text(70, 100, '15', 72)
    if sid in ('6.14.1', '6.14.2'):
        fill, color = (BLUE, W) if sid == '6.14.1' else (YELLOW, BLACK)
        return 200, 120, f'<rect x="4" y="4" width="192" height="112" rx="10" fill="{fill}"/>' + text(100, 60, 'М4' if sid == '6.14.1' else 'E105', 60, color)
    if sid == '6.16':
        return square(f'<rect x="20" y="130" width="160" height="16" fill="{W}"/>' + text(100, 80, 'СТОП', 50, W))
    if sid in ('6.18.1', '6.18.2', '6.18.3'):
        a = {'6.18.1': arrow([(40, 70), (120, 70), (120, 150)], BLACK, 16, 36), '6.18.2': arrow([(160, 70), (80, 70), (80, 150)], BLACK, 16, 36),
             '6.18.3': arrow([(40, 100), (170, 100)], BLACK, 16, 36)}[sid]
        return 200, 200, f'<rect x="4" y="4" width="192" height="192" rx="10" fill="{YELLOW}"/>' + a
    if sid == '6.22':
        cam = f'<rect x="44" y="70" width="90" height="60" rx="8" fill="{W}"/><polygon points="134,90 164,74 164,126 134,110" fill="{W}"/><circle cx="89" cy="100" r="18" fill="{BLUE}"/>'
        return square(cam)

    # 7. Сервиса: синяя рамка, белое поле, пиктограмма
    service = {
        '7.1': f'<rect x="88" y="54" width="24" height="76" fill="{RED}"/><rect x="62" y="80" width="76" height="24" fill="{RED}"/>',
        '7.2': f'<rect x="64" y="50" width="16" height="84" fill="{BLACK}"/><rect x="120" y="50" width="16" height="84" fill="{BLACK}"/><rect x="64" y="84" width="72" height="16" fill="{BLACK}"/>',
        '7.3': f'<rect x="64" y="52" width="52" height="84" rx="4" fill="{BLACK}"/><rect x="72" y="60" width="36" height="24" fill="{WHITE}"/><path d="M116,64 L134,74 L134,118 Q134,126 126,124" stroke="{BLACK}" stroke-width="6" fill="none"/>',
        '7.4': f'<path d="M64,128 L116,76 M110,58 Q122,46 138,54 L124,68 L132,76 L146,62 Q154,78 142,90 Q130,98 118,92" stroke="{BLACK}" stroke-width="12" fill="none" stroke-linecap="round"/>',
        '7.5': place(car(), 100, 110, 90) + ''.join(f'<path d="M{x},52 Q{x - 6},62 {x},70 Q{x + 6},62 {x},52 Z" fill="{BLACK}"/>' for x in (76, 100, 124)),
        '7.6': f'<path d="M66,72 Q66,58 82,58 L118,58 Q134,58 134,72 L122,82 L112,74 L88,74 L78,82 Z" fill="{BLACK}"/><rect x="72" y="88" width="56" height="44" rx="6" fill="{BLACK}"/><circle cx="100" cy="110" r="10" fill="{WHITE}"/>',
        '7.7': f'<path d="M74,54 L74,82 Q74,92 82,92 L82,140 M66,54 L66,80 M82,54 L82,80 M120,54 Q138,68 128,96 L128,140" stroke="{BLACK}" stroke-width="7" fill="none" stroke-linecap="round"/>',
        '7.8': f'<path d="M70,70 L110,70 Q124,70 124,84 L124,92" stroke="{BLACK}" stroke-width="12" fill="none"/><path d="M124,104 Q116,118 124,128 Q132,118 124,104 Z" fill="{BLACK}"/><rect x="62" y="64" width="12" height="74" fill="{BLACK}"/>',
        '7.9': f'<rect x="54" y="98" width="92" height="22" fill="{BLACK}"/><rect x="54" y="72" width="10" height="66" fill="{BLACK}"/><rect x="136" y="110" width="10" height="28" fill="{BLACK}"/><circle cx="80" cy="88" r="10" fill="{BLACK}"/><rect x="94" y="84" width="48" height="12" rx="4" fill="{BLACK}"/>',
        '7.10': f'<polygon points="100,52 148,136 52,136" fill="{BLACK}"/><polygon points="100,92 116,136 84,136" fill="{WHITE}"/>',
        '7.11': f'<polygon points="100,46 132,96 112,96 140,132 60,132 88,96 68,96" fill="{BLACK}"/><rect x="94" y="132" width="12" height="16" fill="{BLACK}"/>',
        '7.12': text(100, 100, 'ДПС', 48),
        '7.13': text(100, 100, 'ПОЛИЦИЯ', 26),
        '7.14.1': text(100, 100, 'ТАМОЖНЯ', 24),
        '7.14.2': text(100, 100, 'КОНТРОЛЬ', 22),
        '7.15': place(car(), 100, 112, 80) + text(100, 62, '87.5 FM', 26),
        '7.16': text(100, 80, 'SOS', 40) + text(100, 124, 'CH 19', 26),
        '7.17': f'<circle cx="74" cy="66" r="10" fill="{BLACK}"/><path d="M60,96 L104,82 L124,96" stroke="{BLACK}" stroke-width="10" fill="none" stroke-linecap="round"/><path d="M50,120 Q62,110 74,120 Q86,130 98,120 Q110,110 122,120 Q134,130 150,120" stroke="{BLACK}" stroke-width="6" fill="none"/>',
        '7.18': text(100, 100, 'WC', 60),
        '7.19': text(100, 74, 'SOS', 40) + f'<rect x="80" y="100" width="40" height="40" rx="4" fill="{BLACK}"/>',
        '7.20': f'<rect x="82" y="66" width="36" height="76" rx="10" fill="{RED}"/><path d="M100,66 L100,52 L124,52 L132,62" stroke="{BLACK}" stroke-width="6" fill="none"/>',
        '7.21': f'<rect x="64" y="52" width="52" height="84" rx="4" fill="{BLACK}"/><polygon points="94,62 78,96 92,96 86,124 104,88 90,88" fill="{YELLOW}"/><path d="M116,64 L134,74 L134,118" stroke="{BLACK}" stroke-width="6" fill="none"/>',
    }
    if sid in service:
        return 200, 240, (f'<rect x="4" y="4" width="192" height="232" rx="10" fill="{BLUE}"/><rect x="22" y="22" width="156" height="156" rx="4" fill="{WHITE}"/>'
                          + service[sid] + f'<rect x="22" y="190" width="156" height="34" fill="{BLUE}"/>')

    # 8. Таблички — белые прямоугольники
    plate = lambda pic, w=300, h=150: white_plate(w, h, pic)
    if sid in ('8.1.1', '8.2.1'):
        pic = text(150, 76, '150 м', 64)
        if sid == '8.2.1':
            pic = arrow([(40, 30), (40, 120)], BLACK, 8, 22).replace('40,30', '40,40') + arrow([(40, 120), (40, 30)], BLACK, 8, 22) + text(170, 76, '150 м', 60)
        return plate(pic)
    if sid in ('8.1.2', '8.1.3', '8.1.4'):
        pic = {'8.1.2': arrow([(60, 100), (240, 100)], BLACK, 8, 24) + text(150, 56, '250 м', 46),
               '8.1.3': arrow([(40, 100), (260, 100)], BLACK, 10, 26) + text(150, 50, '200 м', 44),
               '8.1.4': arrow([(260, 100), (40, 100)], BLACK, 10, 26) + text(150, 50, '200 м', 44)}[sid]
        return plate(pic)
    if sid in ('8.2.2', '8.2.3', '8.2.4', '8.2.5', '8.2.6'):
        pic = {'8.2.2': arrow([(40, 30), (40, 120)], BLACK, 8, 22) + text(170, 76, '50 м', 60),
               '8.2.3': arrow([(150, 30), (150, 120)], BLACK, 10, 26),
               '8.2.4': arrow([(150, 120), (150, 30)], BLACK, 10, 26).replace('150,30', '150,40') + arrow([(150, 30), (150, 120)], BLACK, 10, 26),
               '8.2.5': arrow([(150, 75), (40, 75)], BLACK, 10, 26),
               '8.2.6': arrow([(150, 75), (40, 75)], BLACK, 10, 26) + arrow([(150, 75), (260, 75)], BLACK, 10, 26)}[sid]
        return plate(pic)
    if sid in ('8.3.1', '8.3.2', '8.3.3'):
        pic = {'8.3.1': arrow([(60, 75), (240, 75)], BLACK, 10, 26), '8.3.2': arrow([(240, 75), (60, 75)], BLACK, 10, 26),
               '8.3.3': arrow([(150, 75), (40, 75)], BLACK, 10, 26) + arrow([(150, 75), (260, 75)], BLACK, 10, 26)}[sid]
        return plate(pic)
    kinds = {'1': truck(), '2': car() + '<rect x="70" y="36" width="26" height="22" fill="#111111"/>', '3': car(), '4': bus(), '5': tram(), '6': bicycle(), '7': moto(), '8': truck() + f'<rect x="38" y="44" width="16" height="10" fill="{ORANGE}"/>'}
    if sid.startswith('8.4.'):
        n = int(sid.split('.')[2])
        pic = place(kinds[str((n - 1) % 8 + 1)], 150, 75, 120)
        if n >= 9:
            pic = text(60, 75, 'кроме', 34) + place(kinds[str((n - 9) % 8 + 1)], 200, 75, 110)
        return plate(pic)
    if sid == '8.5.1':
        return plate(place(f'<rect x="10" y="10" width="80" height="80" fill="none" stroke="{BLACK}" stroke-width="6"/><rect x="10" y="10" width="80" height="20" fill="{BLACK}"/>'
                           + ''.join(f'<rect x="{x}" y="{y}" width="10" height="10" fill="{BLACK}"/>' for x in (22, 42, 62) for y in (42, 62)), 150, 75, 110))
    if sid == '8.5.2':
        return plate(place(f'<path d="M20,90 L20,40 L50,20 L80,40 L80,90 Z" fill="{BLACK}"/><rect x="40" y="60" width="20" height="30" fill="{WHITE}"/>', 150, 75, 110))
    if sid == '8.5.3':
        return plate(text(150, 76, 'пн, ср, пт', 48))
    if sid == '8.5.4':
        return plate(text(150, 76, '8.00–17.30', 50))
    if sid in ('8.5.5', '8.5.6', '8.5.7'):
        t = {'8.5.5': ('сб, вс', '8.00–17.30'), '8.5.6': ('раб.', '8.00–17.30'), '8.5.7': ('пн–пт', '8.00–17.30')}[sid]
        return plate(text(150, 48, t[0], 40) + text(150, 104, t[1], 44))
    if sid.startswith('8.6.'):
        n = int(sid.split('.')[2])
        curb = f'<rect x="20" y="110" width="260" height="10" fill="{BLACK}"/>'
        cars = place(car(), 150, 80 if n % 2 else 112, 90)
        return plate(curb + cars + text(150, 30, f'вариант {n}', 20, weight=400))
    if sid == '8.7':
        return plate(place(f'<rect x="10" y="30" width="80" height="50" fill="{BLACK}"/><circle cx="50" cy="55" r="16" fill="{WHITE}"/><path d="M42,47 L58,63 M58,47 L42,63" stroke="{BLACK}" stroke-width="5"/>', 150, 75, 110))
    if sid == '8.8':
        return plate(text(150, 76, 'Платно', 56))
    if sid == '8.9.1':
        return plate(text(150, 76, '2 ч', 64))
    if sid == '8.9.2':
        return plate(text(150, 76, 'Резидент', 46))
    if sid == '8.9.3':
        return plate(text(150, 76, 'CD', 70))
    if sid == '8.10':
        return plate(place(car(), 150, 60, 110) + f'<rect x="90" y="104" width="120" height="10" fill="{BLACK}"/><rect x="100" y="114" width="12" height="20" fill="{BLACK}"/><rect x="188" y="114" width="12" height="20" fill="{BLACK}"/>')
    if sid == '8.11':
        return plate(place(truck(), 90, 75, 100) + text(220, 76, '7,5 т', 46))
    if sid == '8.12':
        return plate(place(car(), 100, 60, 100) + f'<path d="M30,96 L150,96 L250,130 L30,130 Z" fill="{BLACK}"/>')
    if sid == '8.13':
        return plate(f'<path d="M150,140 L150,80 L150,20" stroke="{BLACK}" stroke-width="14"/><path d="M150,80 L240,30" stroke="{BLACK}" stroke-width="14"/><path d="M60,80 L150,80" stroke="{BLACK}" stroke-width="5"/>', 300, 160)
    if sid == '8.14':
        return plate(f'<rect x="20" y="20" width="260" height="110" fill="{BLUE}"/>' + arrow([(90, 120), (90, 34)], WHITE, 12, 28) + arrow([(210, 120), (210, 34)], WHITE, 12, 28) + f'<rect x="146" y="20" width="8" height="110" fill="{WHITE}"/>')
    if sid == '8.15':
        return plate(place(pedestrian(), 120, 75, 110) + f'<path d="M150,40 L200,130" stroke="{BLACK}" stroke-width="6"/>')
    if sid == '8.16':
        return plate(place(car(), 150, 60, 110) + ''.join(f'<path d="M{x},96 Q{x - 8},118 {x},132 Q{x + 8},118 {x},96 Z" fill="{BLACK}"/>' for x in (110, 150, 190)))
    if sid in ('8.17', '8.18'):
        wheel = (f'<circle cx="36" cy="64" r="22" fill="none" stroke="{BLACK}" stroke-width="7"/><circle cx="44" cy="16" r="8" fill="{BLACK}"/>'
                 f'<path d="M44,26 L40,52 L66,52 L74,80" stroke="{BLACK}" stroke-width="8" fill="none" stroke-linecap="round"/>')
        pic = place(wheel, 150 if sid == '8.17' else 200, 75, 110)
        if sid == '8.18':
            pic = text(80, 76, 'кроме', 34) + pic
        return plate(pic)
    if sid == '8.19':
        return plate(f'<polygon points="150,20 210,75 150,130 90,75" fill="{ORANGE}" stroke="{BLACK}" stroke-width="4"/>' + text(150, 76, '3', 46))
    if sid in ('8.20.1', '8.20.2'):
        axles = 2 if sid == '8.20.1' else 3
        return plate(f'<rect x="60" y="56" width="180" height="12" fill="{BLACK}"/>' + ''.join(f'<circle cx="{150 + (i - (axles - 1) / 2) * 50}" cy="92" r="18" fill="{BLACK}"/>' for i in range(axles)))
    if sid.startswith('8.21.'):
        pic = {'8.21.1': bus(), '8.21.2': tram(), '8.21.3': bus() + '<path d="M40,28 L30,6 M60,28 L50,6" stroke="#111111" stroke-width="4"/>'}[sid]
        return plate(place(pic, 150, 75, 120))
    if sid.startswith('8.22.'):
        stripes = ''.join(f'<polygon points="{x},0 {x + 30},0 {x - 30},300 {x - 60},300" fill="{RED}"/>' for x in range(-40, 320, 60))
        if sid == '8.22.2':
            stripes = f'<g transform="translate(100,0) scale(-1,1)">{stripes}</g>'
        if sid == '8.22.3':
            stripes = f'<g transform="translate(0,0)">{stripes}</g>'
        return 100, 300, f'<clipPath id="c{sid.replace(".", "")}"><rect x="4" y="4" width="92" height="292"/></clipPath><rect x="4" y="4" width="92" height="292" fill="{WHITE}" stroke="{BLACK}" stroke-width="3"/><g clip-path="url(#c{sid.replace(".", "")})">{stripes}</g>'
    if sid == '8.24':
        return plate(place(truck(), 110, 75, 110) + place(car(), 210, 66, 70))
    if sid == '8.25':
        return plate(text(150, 76, 'ЭКО 4', 54))
    if sid == '8.26':
        return plate(f'<rect x="110" y="30" width="60" height="96" rx="6" fill="{BLACK}"/><polygon points="146,40 122,82 140,82 132,116 160,70 142,70" fill="{YELLOW}"/>')
    return None
