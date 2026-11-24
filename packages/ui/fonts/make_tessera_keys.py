"""Build Tessera Keys (TesseraKeys.woff2, next to this script): the key and symbol glyphs Instrument Sans and
Instrument Serif lack. From the v5 design system (tessera-lab v5/system/build/build_keys.py), unchanged but for the
output path.

  python3 make_tessera_keys.py        (needs fontTools and brotli: pip install fonttools brotli)

Without it, ⌘ ⏎ ⇧ ⌥ ⌫ ⇥ ⌃ Δ fall back to whatever sans the OS has (DejaVu on Linux, SF on a Mac), so every key
hint was set in a different face at a different weight. These are drawn once, in the icons' grammar (p07): square
ends, straight strokes, mitred joins, no curves, at Instrument Sans's cap height (720) with a stem between its 400 and
500 weights (88 units). tokens.css lists 'Tessera Keys' straight after each text face, so the browser only ever
reaches for it for these code points.
"""
import math, os
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = HERE
STEM = 74
CAP = 720
SIDE_BEARING = 60


def area(poly):
    return sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(poly, poly[1:] + poly[:1])) / 2


def cw(poly):      # TrueType: outer contours clockwise (y up) = negative signed area
    return poly if area(poly) < 0 else poly[::-1]


def ccw(poly):
    return poly[::-1] if area(poly) < 0 else poly


def rect(x0, y0, x1, y1):
    return cw([(x0, y0), (x0, y1), (x1, y1), (x1, y0)])


def _isect(p, d, q, e):
    den = d[0] * e[1] - d[1] * e[0]
    if abs(den) < 1e-9:
        return p
    t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den
    return (p[0] + t * d[0], p[1] + t * d[1])


def offset(pts, dist, closed):
    """Offset a polyline by dist to its left, mitred at every joint."""
    n = len(pts)
    segs = [(pts[i], pts[(i + 1) % n]) for i in range(n if closed else n - 1)]
    lines = []
    for (a, b) in segs:
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy)
        nx, ny = -dy / L, dx / L
        lines.append(((a[0] + nx * dist, a[1] + ny * dist), (dx, dy), (b[0] + nx * dist, b[1] + ny * dist)))
    out = []
    for i in range(n):
        if not closed and i == 0:
            out.append(lines[0][0]); continue
        if not closed and i == n - 1:
            out.append(lines[-1][2]); continue
        l0, l1 = lines[i - 1], lines[i % len(lines)]
        out.append(_isect(l0[0], l0[1], l1[0], l1[1]))
    return out


def stroke(pts, w=STEM):
    """An open polyline as one filled outline: square ends, mitred joins."""
    left, right = offset(pts, w / 2, False), offset(pts, -w / 2, False)
    return [cw(left + right[::-1])]


def outline(pts, w=STEM):
    """A closed shape drawn as a line w thick, centred on the path: an outer and an inner contour."""
    a, b = offset(pts, w / 2, True), offset(pts, -w / 2, True)
    outer, inner = (a, b) if abs(area(a)) > abs(area(b)) else (b, a)
    return [cw(outer), ccw(inner)]


def tri(*p):
    return [cw(list(p))]


G = {}

def cmd():
    b, L, s = 680, 230, 68
    cs = [rect(L - s / 2, 0, L + s / 2, b), rect(b - L - s / 2, 0, b - L + s / 2, b),
          rect(0, L - s / 2, b, L + s / 2), rect(0, b - L - s / 2, b, b - L + s / 2)]
    for (x0, x1) in ((0, s), (b - s, b)):
        cs += [rect(x0, 0, x1, L), rect(x0, b - L, x1, b)]
    for (y0, y1) in ((0, s), (b - s, b)):
        cs += [rect(0, y0, L, y1), rect(b - L, y0, b, y1)]
    return cs
G['uni2318'] = ([0x2318], 700, cmd())

G['uni21E7'] = ([0x21E7], 700, outline([(200, 44), (200, 340), (44, 340), (350, 676), (656, 340), (500, 340), (500, 44)]))

G['uni2325'] = ([0x2325], 720, stroke([(0, 676), (250, 676), (470, 44), (720, 44)]) + [rect(470, 632, 720, 720)])

G['uni2303'] = ([0x2303], 640, stroke([(30, 300), (320, 650), (610, 300)]))

def ret():
    return stroke([(663, 720), (663, 250), (40, 250)]) + stroke([(250, 460), (40, 250), (250, 40)])
G['uni23CE'] = ([0x23CE, 0x21B5], 700, ret())

def tab(mirror=False):
    cs = stroke([(0, 360), (600, 360)]) + stroke([(400, 560), (600, 360), (400, 160)]) + [rect(720 - STEM, 110, 720, 610)]
    if mirror:
        cs = [cw([(720 - x, y) for x, y in c]) for c in cs]
    return cs
G['uni21E5'] = ([0x21E5], 720, tab())
G['uni21E4'] = ([0x21E4], 720, tab(True))

def bksp():
    o = outline([(44, 360), (250, 676), (716, 676), (716, 44), (250, 44)])
    c = 470
    x = stroke([(c - 120, 240), (c + 120, 480)], STEM) + stroke([(c - 120, 480), (c + 120, 240)], STEM)
    return o + x
G['uni232B'] = ([0x232B], 760, bksp())

G['uni0394'] = ([0x0394], 700, outline([(48, 44), (350, 676), (652, 44)]))

ORDER = ['.notdef', 'space'] + list(G)
fb = FontBuilder(1000, isTTF=True)
fb.setupGlyphOrder(ORDER)
cmap = {0x20: 'space'}
for name, (us, adv, cs) in G.items():
    for u in us:
        cmap[u] = name
fb.setupCharacterMap(cmap)
glyphs, metrics = {}, {}
pen = TTGlyphPen(None); glyphs['.notdef'] = pen.glyph(); metrics['.notdef'] = (500, 0)
pen = TTGlyphPen(None); glyphs['space'] = pen.glyph(); metrics['space'] = (260, 0)
for name, (us, adv, cs) in G.items():
    pen = TTGlyphPen(None)
    for c in cs:
        pts = [(round(x + SIDE_BEARING), round(y)) for x, y in c]
        pen.moveTo(pts[0])
        for p in pts[1:]:
            pen.lineTo(p)
        pen.closePath()
    glyphs[name] = pen.glyph()
    metrics[name] = (adv + 2 * SIDE_BEARING, SIDE_BEARING)
fb.setupGlyf(glyphs)
for name in glyphs:
    g = fb.font['glyf'][name]
    if hasattr(g, 'xMin') and g.numberOfContours:
        metrics[name] = (metrics[name][0], g.xMin)
fb.setupHorizontalMetrics(metrics)
fb.setupHorizontalHeader(ascent=970, descent=-250)
fb.setupNameTable({'familyName': 'Tessera Keys', 'styleName': 'Regular', 'uniqueFontIdentifier': 'Tessera Keys 1.0',
                   'fullName': 'Tessera Keys', 'psName': 'TesseraKeys-Regular', 'version': 'Version 1.000',
                   'licenseDescription': 'SIL Open Font License 1.1'})
fb.setupOS2(sTypoAscender=970, sTypoDescender=-250, sTypoLineGap=0, usWinAscent=986, usWinDescent=350,
            sCapHeight=720, sxHeight=510, achVendID='TSRA', fsType=0)
fb.setupPost()
fb.font.flavor = 'woff2'
os.makedirs(OUT, exist_ok=True)
path = os.path.join(OUT, 'TesseraKeys.woff2')
fb.save(path)
print('wrote', path, len(G), 'glyphs')
