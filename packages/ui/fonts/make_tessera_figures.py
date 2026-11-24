"""Tessera Figures: figures-only, tabular derivative of Instrument Serif (OFL-1.1, The Instrument Serif Project Authors).
Keeps 0-9 . , + U+2212 % $ : and space; gives every digit one advance (ADV); centres each digit's ink in it; drops kerning.
Stack it in front of Instrument Serif so letters stay Instrument and every figure is tabular (prices stop jittering).

Usage (fontTools with brotli, `pip install fonttools brotli`), from packages/ui/fonts:
    python3 make_tessera_figures.py InstrumentSerif-Regular.woff2 TesseraFigures-Regular.woff2 420
See README.md in this directory."""
import sys
from fontTools.ttLib import TTFont
from fontTools import subset
SRC, OUT, ADV = sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 420
f = TTFont(SRC)
opts = subset.Options(); opts.layout_features = []; opts.name_IDs = ['*']; opts.notdef_outline = True
opts.drop_tables += ['GPOS', 'kern', 'STAT']; opts.flavor = 'woff2'
s = subset.Subsetter(opts); s.populate(unicodes=[ord(c) for c in '0123456789.,+−%$: ']); s.subset(f)
cmap = f.getBestCmap(); hmtx = f['hmtx']; glyf = f['glyf']
for d in '0123456789':
    g = cmap[ord(d)]; gl = glyf[g]; gl.recalcBounds(glyf)
    ink = gl.xMax - gl.xMin; dx = round((ADV - ink) / 2) - gl.xMin
    if gl.isComposite():
        for c in gl.components: c.x += dx
    else:
        gl.coordinates.translate((dx, 0))
    gl.recalcBounds(glyf); hmtx[g] = (ADV, gl.xMin)
name = f['name']
for rec in list(name.names):
    if rec.nameID in (1, 4, 16, 21): rec.string = 'Tessera Figures' if rec.nameID != 4 else 'Tessera Figures Regular'
    elif rec.nameID == 6: rec.string = 'TesseraFigures-Regular'
    elif rec.nameID == 3: rec.string = 'TesseraFigures-Regular;derived from Instrument Serif'
f.save(OUT)
print('wrote', OUT)
