import sys, numpy as np
from PIL import Image
from grid import line_runs
from cells import cells_of
from cluster_lib import classify
from rapidocr_onnxruntime import RapidOCR
ocr = RapidOCR()

def tabrows(im):
    out = []
    for (y0, y1) in line_runs(im):
        band = im[y0:y1 + 1]
        cols = np.where(band.sum(0) > 0)[0]
        mid = band[(y1 - y0) // 2 - 1:(y1 - y0) // 2 + 3].sum(0) > 0
        if len(cols) and cols.max() - cols.min() > 200 and mid.sum() > 80:
            out.append((y0, y1))
    return out

def groups(rows):
    out, cur = [], []
    for r in rows:
        if cur and r[0] - cur[-1][1] > 20:
            out.append(cur); cur = []
        cur.append(r)
    if cur: out.append(cur)
    return [g for g in out if len(g) >= 6]

def column_text(gray, f):
    im = gray < 150
    gs = groups(tabrows(im))
    items = []
    k = 0
    while k < len(gs):
        g = gs[k]
        tail = g[6:12] if len(g) >= 12 else None
        p, a, cells = cells_of(im, g[:6])
        rows = [''.join(classify(c) for c in row) for row in cells]
        if tail:
            p2, a2, c2 = cells_of(im, tail)
            t = [''.join(classify(c) for c in row) for row in c2]
            rows = [r + s for r, s in zip(rows, t)]
        elif k + 1 < len(gs) and gs[k + 1][0][0] - g[5][1] < 40:
            nxt = gs[k + 1]
            p2, a2, c2 = cells_of(im, nxt[:6])
            t = [''.join(classify(c) for c in row) for row in c2]
            if t[0][0] == '-':
                rows = [r + s for r, s in zip(rows, t)]
                k += 1
        items.append((g[0][0], 'T', rows, g))
        k += 1
    res, _ = ocr(gray)
    spans = [(g[0][0] - 3, g[-1][1] + 3) for g in gs]
    for box, txt, conf in (res or []):
        ys = [q[1] for q in box]; y = (min(ys) + max(ys)) / 2
        xs = [q[0] for q in box]
        if any(s <= y <= e for s, e in spans):
            if min(xs) > 0 and txt.strip()[:3].replace('x', '').replace('X', '').strip().isdigit():
                items.append((y, 'R', txt.strip(), None))
            continue
        items.append((y, 'L', txt.strip(), None))
    items.sort(key=lambda i: i[0])
    out = []
    for y, kind, v, g in items:
        if kind == 'T': out += v + ['']
        elif kind == 'L': out.append(v)
        elif len(out) >= 2: out[-2] += '  ' + v
    return out

def page_text(f, split=None):
    gray = np.array(Image.open(f).convert('L'))
    parts = [gray] if not split else [gray[:, :split], gray[:, split:]]
    out = []
    for p in parts: out += column_text(np.ascontiguousarray(p), f)
    return '\n'.join(out)

if __name__ == '__main__':
    print(page_text(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else None))
