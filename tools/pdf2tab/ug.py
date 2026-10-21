import sys, glob, numpy as np
from PIL import Image
from scipy import ndimage as ndi

def load(f):
    a = np.array(Image.open(f).convert('L'))
    return a < 140, a < 205

def staff_of(ink):
    h, w = ink.shape
    cover = ink.sum(1)
    rows = [y for y in range(h) if cover[y] > 0.5 * w]
    # merge adjacent rows into lines
    lines = []
    for y in rows:
        if lines and y - lines[-1][-1] <= 1: lines[-1].append(y)
        else: lines.append([y])
    ys = [np.mean(l) for l in lines]
    # find 6 equally spaced
    for i in range(len(ys) - 5):
        d = np.diff(ys[i:i + 6])
        if d.min() > 6 and d.max() - d.min() < 3:
            return ys[i:i + 6]
    return None

def barlines(ink, ys):
    t, b = int(ys[0]), int(ys[-1])
    col = ink[t:b + 1].mean(0) > 0.97
    xs = np.where(col)[0]
    groups = []
    for x in xs:
        if groups and x - groups[-1][-1] <= 2: groups[-1].append(x)
        else: groups.append([x])
    return [float(np.mean(g)) for g in groups]

def components(ink, ys, bars):
    u = (ys[-1] - ys[0]) / 5
    t, b = int(ys[0] - 0.8 * u), int(ys[-1] + 0.8 * u)
    reg = ink[t:b + 1].copy()
    # erase staff lines (long thin horizontal runs)
    for y in ys:
        for yy in range(int(round(y)) - 1 - t, int(round(y)) + 2 - t):
            if 0 <= yy < reg.shape[0]:
                row = reg[yy]
                lab, n = ndi.label(row)
                for k in range(1, n + 1):
                    idx = np.where(lab == k)[0]
                    if len(idx) > 1.6 * u:
                        # keep pixels that are part of thick strokes (vertical neighbours beyond line)
                        reg[yy, idx] = False
    # erase bar lines
    for x in bars:
        reg[:, max(0, int(round(x)) - 2):int(round(x)) + 3] = False
    lab, n = ndi.label(reg, structure=np.ones((3, 3)))
    objs = ndi.find_objects(lab)
    comps = []
    for i, sl in enumerate(objs):
        hh = sl[0].stop - sl[0].start; ww = sl[1].stop - sl[1].start
        m = (lab[sl] == i + 1)
        comps.append(dict(x0=sl[1].start, x1=sl[1].stop, y0=sl[0].start + t, y1=sl[0].stop + t, h=hh, w=ww, mask=m, area=int(m.sum())))
    return u, comps

if __name__ == '__main__':
    for f in sorted(glob.glob('ug_p1_*.png')):
        ink, light = load(f)
        ys = staff_of(light)
        print(f, ink.shape, None if ys is None else [round(y, 1) for y in ys])
        if ys:
            bars = barlines(light, ys)
            u, comps = components(ink, ys, bars)
            print('  u', round(u, 1), 'bars', [round(b) for b in bars], 'comps', len(comps), [(c['h'], c['w']) for c in comps][:12])
