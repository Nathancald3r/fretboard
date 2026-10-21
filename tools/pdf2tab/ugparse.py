import glob, json, sys, numpy as np
from PIL import Image
from ug import load, staff_of, barlines, components
from ugclu import norm, W, H
LAB = {5:'1',4:'1',31:'1',33:'X',34:'X',35:'X',3:'0',15:'0',1:'0',16:'0',13:'0',6:'0',18:'8',22:'8',2:'8',9:'8',0:'8',43:'8',
       24:'5',25:'5',32:'5',39:'2',38:'2',44:'2',14:'3',17:'3',28:'3',19:'3',27:'3',42:'3',7:'7',10:'7',52:'7',23:'6',26:'6',29:'4'}
reps = np.load('ugreps.npy')

def glyph(c, u):
    n = norm(c, u)
    if n is None: return None
    d = (reps != n).reshape(len(reps), -1).sum(1)
    i = int(d.argmin())
    return LAB.get(i) if d[i] <= 40 else None

def parse_strip(f):
    ink, light = load(f)
    ys = staff_of(light)
    if not ys: return None
    bars = barlines(light, ys)
    u, comps = components(ink, ys, bars)
    gl = []
    for c in comps:
        cy = (c['y0'] + c['y1']) / 2
        if c['h'] < 0.45 * u or c['area'] < 18 or c['h'] > 1.3 * u or c['w'] > 1.3 * u: continue
        if cy < ys[0] - 0.45 * u or cy > ys[-1] + 0.45 * u: continue
        ch = glyph(c, u)
        if ch is None: continue
        string = int(np.argmin([abs(cy - y) for y in ys]))
        gl.append(dict(x0=c['x0'], x1=c['x1'], cx=(c['x0'] + c['x1']) / 2, s=string, ch=ch))
    gl.sort(key=lambda g: (g['s'], g['x0']))
    notes = []
    for g in gl:
        if notes and notes[-1]['s'] == g['s'] and g['x0'] - notes[-1]['x1'] < 0.3 * u and notes[-1]['t'] != 'X' and g['ch'] != 'X':
            notes[-1]['t'] += g['ch']; notes[-1]['x1'] = g['x1']
        else:
            notes.append(dict(s=g['s'], x0=g['x0'], x1=g['x1'], t=g['ch']))
    for n in notes: n['cx'] = (n['x0'] + n['x1']) / 2
    notes.sort(key=lambda n: n['cx'])
    out = []
    for bi in range(len(bars) - 1):
        a, b = bars[bi], bars[bi + 1]
        out.append(dict(x0=a, x1=b, notes=[n for n in notes if a < n['cx'] < b]))
    return dict(u=u, bars=out)

if __name__ == '__main__':
    for f in sys.argv[1:]:
        p = parse_strip(f)
        print(f, 'u', p['u'])
        for b in p['bars']:
            print(' bar', round(b['x0']), round(b['x1']), [(round(n['cx']), n['s'] + 1, n['t']) for n in b['notes']])
