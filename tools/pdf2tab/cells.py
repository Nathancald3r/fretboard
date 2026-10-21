import sys, json, numpy as np
from PIL import Image
from grid import load, systems

def pitch_of(im, rows):
    best = []
    for (y0, y1) in rows:
        prof = im[y0:y1 + 1].sum(0) > 0
        starts = [i for i in range(1, len(prof)) if prof[i] and not prof[i - 1]]
        run = [starts[0]]
        for s in starts[1:]:
            if 9 <= s - run[-1] <= 13: run.append(s)
            else:
                if len(run) > len(best): best = run
                run = [s]
        if len(run) > len(best): best = run
    idx = np.arange(len(best))
    return float(np.polyfit(idx, best, 1)[0])

def cells_of(im, rows):
    rows = rows[:6]
    p0 = pitch_of(im, rows)
    starts = []
    for (ya, yb) in rows:
        yc = (ya + yb) // 2
        prof = im[yc - 1:yc + 3].sum(0) > 0
        i = 0
        while i < len(prof):
            if prof[i]:
                j = i
                while j < len(prof) and prof[j]: j += 1
                if 6 <= j - i <= 8: starts.append(i)
                i = j
            else: i += 1
    starts = np.array(starts, float)
    ref = starts[0]
    p = p0
    for _ in range(4):
        k = np.round((starts - ref) / p)
        p, ref = np.polyfit(k, starts, 1)
    left = starts.min() - 11.2 * 0 
    # first cell index so that the leftmost glyph of the row sits in cell 0
    prof0 = im[rows[0][0]:rows[0][1] + 1].sum(0) > 0
    xs = np.where(prof0)[0]
    k0 = int(np.floor((xs.min() + 3.5 - (ref + 3.5)) / p + 0.5))
    n = int((xs.max() + 6 - (ref + 3.5)) / p - k0) + 1
    out = []
    for (ya, yb) in rows:
        yc = (ya + yb) // 2
        line = []
        for k in range(n):
            xc = ref + 3.5 + (k0 + k) * p
            xa = int(round(xc - p / 2)); xb = int(round(xc + p / 2))
            line.append(im[yc - 10:yc + 11, xa:xb])
        out.append(line)
    return p, ref, out

def key(c):
    return c.astype(np.uint8).tobytes()

if __name__ == '__main__':
    f = sys.argv[1]
    im = load(f)
    for sy in systems(im):
        p, a, cells = cells_of(im, sy)
        print(f, 'pitch', round(p, 3), 'cells', len(cells[0]))
        break
