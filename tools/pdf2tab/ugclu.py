import glob, json, numpy as np
from PIL import Image, ImageDraw
from ug import load, staff_of, barlines, components

W, H = 14, 18
def norm(c, u):
    k = 18.0 / u
    m = Image.fromarray((c['mask'] * 255).astype(np.uint8))
    if abs(k - 1) > 0.03:
        m = m.resize((max(1, round(m.width * k)), max(1, round(m.height * k))), Image.BILINEAR)
    a = np.array(m) > 127
    out = np.zeros((H, W), np.uint8)
    h, w = a.shape
    y0 = (H - h) // 2; x0 = (W - w) // 2
    if h > H or w > W: return None
    out[y0:y0 + h, x0:x0 + w] = a
    return out

def main():
    clusters = []
    def assign(c):
        best, bd = None, 1e9
        for i, (rep, n) in enumerate(clusters):
            d = int((rep != c).sum())
            if d < bd: best, bd = i, d
        if best is not None and bd <= 14:
            clusters[best][1] += 1
            return best
        clusters.append([c, 1])
        return len(clusters) - 1

    recs = []
    for f in sorted(glob.glob('ug_p*_*.png')):
        ink, light = load(f)
        ys = staff_of(light)
        if not ys: continue
        bars = barlines(light, ys)
        u, comps = components(ink, ys, bars)
        for c in comps:
            if c['h'] < 0.45 * u or c['area'] < 18 or c['h'] > 1.3 * u or c['w'] > 1.3 * u: continue
            n = norm(c, u)
            if n is None: continue
            recs.append((f, c['x0'], c['y0'], assign(n)))
    print(len(clusters), 'clusters', len(recs), 'comps')
    order = sorted(range(len(clusters)), key=lambda i: -clusters[i][1])
    S = 5; cols = 12
    rows = (len(order) + cols - 1) // cols
    img = Image.new('L', (cols * (W * S + 10), rows * (H * S + 20)), 255)
    d = ImageDraw.Draw(img)
    for n, i in enumerate(order):
        x = (n % cols) * (W * S + 10); y = (n // cols) * (H * S + 20)
        rep = (1 - clusters[i][0]) * 255
        img.paste(Image.fromarray(rep.astype(np.uint8)).resize((W * S, H * S), Image.NEAREST), (x + 3, y + 13))
        d.text((x + 3, y), f'{i}:{clusters[i][1]}', fill=0)
    img.save('ugmontage.png')
    np.save('ugreps.npy', np.array([c[0] for c in clusters]))
    json.dump(recs, open('ugrecs.json', 'w'))

if __name__=='__main__': main()
