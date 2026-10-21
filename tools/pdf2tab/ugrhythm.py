import sys, numpy as np
from ug import load, staff_of, barlines
from ugparse import parse_strip

def bands(col):
    """count separate ink bands in a 1-D boolean column"""
    out, cur = 0, False
    for v in col:
        if v and not cur: out += 1
        cur = bool(v)
    return out

def stems_of(ink, ys, u):
    y0 = int(ys[-1] + 0.5 * u); y1 = int(ys[-1] + 3.2 * u)
    reg = ink[y0:y1]
    cols = []
    for x in range(reg.shape[1]):
        col = reg[:, x]; best = cur = 0; end = 0
        for i, v in enumerate(col):
            cur = cur + 1 if v else 0
            if cur > best: best, end = cur, i
        if best >= 0.7 * u: cols.append((x, end - best + 1, end))
    groups = []
    for c in cols:
        if groups and c[0] - groups[-1][-1][0] <= 2: groups[-1].append(c)
        else: groups.append([c])
    out = []
    for g in groups:
        out.append(dict(x=float(np.mean([c[0] for c in g])), top=y0 + min(c[1] for c in g), bot=y0 + max(c[2] for c in g), w=len(g)))
    return out, y0, y1

def classify_stem(ink, s, u):
    x = int(round(s['x'])); yb = s['bot']
    def band_count(xa, xb):
        xa, xb = int(xa), int(xb)
        seg = ink[s['top']:yb + 2, xa:xb + 1]
        if seg.size == 0: return 0, 0
        prof = seg.mean(1) > 0.6
        return bands(prof), int(prof.sum())
    # right side / left side extents
    r_near = band_count(x + 0.45 * u, x + 0.7 * u)
    r_far = band_count(x + 1.0 * u, x + 1.2 * u)
    l_near = band_count(x - 0.7 * u, x - 0.45 * u)
    l_far = band_count(x - 1.2 * u, x - 1.0 * u)
    beams = 0; kind = 'plain'
    if r_far[0] or l_far[0]:
        kind = 'beam'; beams = max(r_far[0], l_far[0], 1)
    elif r_near[0]:
        kind = 'flag'; beams = r_near[0]
    # dot: small blob right of the stem around mid height
    dot = False
    mid = (s['top'] + yb) // 2
    patch = ink[mid - int(0.5 * u):mid + int(0.5 * u), x + int(0.5 * u):x + int(1.1 * u)]
    if patch.size and 6 <= patch.sum() <= 60 and kind != 'beam':
        dot = True
    return kind, beams, dot

if __name__ == '__main__':
    for f in sys.argv[1:]:
        p = parse_strip(f)
        ink, light = load(f)
        ys = staff_of(light); u = p['u']
        st, y0, y1 = stems_of(ink, ys, u)
        print(f)
        for b in p['bars']:
            cols = sorted({round(n['cx']) for n in b['notes']})
            row = []
            for cx in cols:
                s = min(st, key=lambda q: abs(q['x'] - cx)) if st else None
                if s is None or abs(s['x'] - cx) > 0.6 * u: row.append((cx, None)); continue
                row.append((cx, classify_stem(ink, s, u)))
            print(' bar', round(b['x0']), round(b['x1']), row)
