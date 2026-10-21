import numpy as np
H, W = 21, 12
L = {2:'-',1:'|',7:'|',5:'1',3:'1',4:'1',19:'1',18:'0',6:'0',11:'0',9:'3',16:'3',17:'3',0:'e',8:'B',10:'G',12:'D',14:'A',15:'E',21:'2',13:'2',20:'2',22:'4',23:'6'}
reps = np.load('reps.npy')

def norm(c):
    out = np.zeros((H, W), np.uint8)
    h, w = c.shape
    out[:min(h, H), :min(w, W)] = c[:H, :W]
    return out

def classify(c):
    c = norm(c)
    if c.sum() == 0: return ' '
    best = (999, 0)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            m = np.roll(np.roll(c, dx, 1), dy, 0)
            d = ((reps != m).reshape(len(reps), -1).sum(1))
            i = int(d.argmin())
            if d[i] < best[0]: best = (int(d[i]), i)
    return L[best[1]] if best[0] <= 40 else '?'
