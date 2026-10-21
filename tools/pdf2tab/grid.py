import sys, numpy as np
from PIL import Image

def load(f):
    return np.array(Image.open(f).convert('L')) < 150

def line_runs(im, x0=0):
    rows = im.sum(1) > 0
    runs, s = [], None
    for y, v in enumerate(rows):
        if v and s is None: s = y
        if not v and s is not None: runs.append((s, y - 1)); s = None
    return runs

def systems(im):
    """Rows that are long dashed lines (tab strings), grouped in sixes."""
    tab = []
    for (y0, y1) in line_runs(im):
        band = im[y0:y1 + 1]
        cols = np.where(band.sum(0) > 0)[0]
        mid = band[(y1 - y0) // 2 - 1:(y1 - y0) // 2 + 3].sum(0) > 0
        if len(cols) and cols.max() - cols.min() > 300 and mid.sum() > 150:
            tab.append((y0, y1))
    out, cur = [], []
    for r in tab:
        if cur and r[0] - cur[-1][1] > 20:
            if len(cur) >= 6: out.append(cur)
            cur = []
        cur.append(r)
    if len(cur) >= 6: out.append(cur)
    return out

if __name__ == '__main__':
    im = load(sys.argv[1])
    for sy in systems(im):
        print(len(sy), sy[0], sy[-1])
        # horizontal profile of first string row
        y0, y1 = sy[0]
        cols = im[y0:y1 + 1].sum(0) > 0
        xs = np.where(cols)[0]
        print('  x range', xs.min(), xs.max())
