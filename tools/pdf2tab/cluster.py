import glob, json, numpy as np
from PIL import Image, ImageDraw
from grid import load, systems
from cells import cells_of

W, H = 12, 21
def norm(c):
    out = np.zeros((H, W), np.uint8)
    h, w = c.shape
    out[:min(h, H), :min(w, W)] = c[:H, :W]
    return out

clusters = []  # [rep, count]
def assign(c):
    best, bd = None, 1e9
    for i, (rep, n) in enumerate(clusters):
        d = int((rep != c).sum())
        if d < bd: best, bd = i, d
    if best is not None and bd <= 6:
        clusters[best][1] += 1
        return best
    clusters.append([c, 1])
    return len(clusters) - 1

grids = {}
for f in sorted(glob.glob('t*_p*_*.jpg')):
    im = load(f)
    for si, sy in enumerate(systems(im)):
        if len(sy) != 6: continue
        p, a, cells = cells_of(im, sy)
        g = [[assign(norm(c)) for c in line] for line in cells]
        grids[f'{f}#{si}'] = g
print(len(clusters), 'clusters')
json.dump(grids, open('grids.json', 'w'))
np.save('reps.npy', np.array([c[0] for c in clusters]))
order = sorted(range(len(clusters)), key=lambda i: -clusters[i][1])
S = 6
cols = 10
rows = (len(order) + cols - 1) // cols
img = Image.new('L', (cols * (W * S + 14), rows * (H * S + 22)), 255)
d = ImageDraw.Draw(img)
for n, i in enumerate(order):
    x = (n % cols) * (W * S + 14); y = (n // cols) * (H * S + 22)
    rep = (1 - clusters[i][0]) * 255
    img.paste(Image.fromarray(rep.astype(np.uint8)).resize((W * S, H * S), Image.NEAREST), (x + 4, y + 14))
    d.text((x + 4, y + 1), f'{i}:{clusters[i][1]}', fill=0)
img.save('montage.png')
