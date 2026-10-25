"""Good stems of a recording: drums, bass, guitar, piano, vocals and the rest, as WAV files.

    python tests/yt2gp5/stems.py URL [--name NAME]     a YouTube link (the song's name is taken from its title)
    python tests/yt2gp5/stems.py --page                rewrite every song's listening page only

Each song gets index.html beside its stems: all six and the recording play together in step, each with
Solo and Mute (open it through the dev server, e.g. http://localhost:8421/tests/yt2gp5/out/stems/<song>/).

Two Demucs models, each where it is best, on the GPU when there is one (free, on this computer):
  htdemucs_ft  drums, bass, vocals (four fine-tuned models, the cleanest Demucs has; ~4× slower)
  htdemucs_6s  guitar and piano (the only Demucs with those two)
  other        the recording minus the five above, so the six always add back up to the recording

Written to out/stems/<song>/ at 44.1 kHz stereo, with stems.json: each stem's loudness and how much of the
recording the six give back (the leftover after adding them up, in dB under the recording). The download is
cached in cache/real/<song>/, so a second run only splits.
"""
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import real  # noqa: E402
import run  # noqa: E402

OUT = HERE / "out" / "stems"
SR = 44100


def separate(model_name, x, model_sr):
    """{stem: (2, n) at model_sr} from one Demucs model; shorter pieces, then the CPU, when the GPU is full."""
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model
    model = get_model(model_name)
    model.eval()
    ref = x.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    mix = ((x - mean) / std)[None]
    tries = [("cuda", None), ("cuda", 7.0), ("cpu", None)] if torch.cuda.is_available() else [("cpu", None)]
    for dev, seg in tries:
        try:
            with torch.no_grad():
                y = apply_model(model, mix, device=dev, split=True, overlap=0.25, shifts=1, progress=False,
                                **({"segment": seg} if seg else {}))[0]
            break
        except RuntimeError as e:
            if "out of memory" not in str(e).lower():
                raise
            torch.cuda.empty_cache()
    return {n: (y[i] * std + mean) for i, n in enumerate(model.sources)}


PAGE = """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stems</title><style>
:root{--bg:#fafaf8;--fg:#1d1d1b;--mute:#6b6b66;--line:#deded8;--acc:#1565c0}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ececea;--mute:#9a9a94;--line:#33332f;--acc:#64b5f6}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:16px}h1{font-size:20px;margin:0 0 4px}.m{color:var(--mute);font-size:13px}
.row{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--line)}.row b{flex:1}
button{font:inherit;padding:5px 12px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}
button.on{background:var(--acc);color:var(--bg);border-color:var(--acc)}button:disabled{opacity:.4}
.bar{display:flex;gap:8px;align-items:center;margin:12px 0}input[type=range]{flex:1}
</style></head><body><main><h1 id="t"></h1><div class="m" id="st">Loading the stems…</div>
<div class="bar"><button id="play" disabled>Play</button><input id="pos" type="range" min="0" max="1" step="0.1" value="0"><span id="time" class="m">0:00</span></div>
<div id="rows"></div><p class="m">Solo plays only the soloed stems. The recording is off at first: turn it on to compare.</p></main>
<script>
const D = __DATA__;
document.getElementById('t').textContent = D.name;
const ctx = new AudioContext(), tracks = [];
let start = 0, at = 0, playing = false, len = 0;
const fmt = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
function gains() {
  const solo = tracks.some(t => t.solo);
  for (const t of tracks) t.g.gain.value = (solo ? t.solo : !t.mute) ? 1 : 0;
}
function stop() { for (const t of tracks) if (t.src) { t.src.stop(); t.src = null; } }
function play(from) {
  stop(); at = from; start = ctx.currentTime;
  for (const t of tracks) { t.src = ctx.createBufferSource(); t.src.buffer = t.buf; t.src.connect(t.g); t.src.start(0, from); }
}
(async () => {
  let n = 0;
  await Promise.all(D.files.map(async ([name, file, mute]) => {
    const buf = await ctx.decodeAudioData(await (await fetch(file)).arrayBuffer());
    const g = ctx.createGain(); g.connect(ctx.destination);
    tracks.push({ name, buf, g, mute, solo: false, order: D.files.findIndex(f => f[0] === name) });
    document.getElementById('st').textContent = `Loading the stems… ${++n} of ${D.files.length}`;
  }));
  tracks.sort((a, b) => a.order - b.order);
  len = Math.max(...tracks.map(t => t.buf.duration));
  document.getElementById('pos').max = len;
  const rows = document.getElementById('rows');
  for (const t of tracks) {
    const r = document.createElement('div'); r.className = 'row';
    r.innerHTML = `<b>${t.name}</b><span class="m">${D.db[t.name] ?? ''}</span><button data-k="solo">Solo</button><button data-k="mute">Mute</button>`;
    r.querySelectorAll('button').forEach(b => {
      const k = b.dataset.k; b.classList.toggle('on', !!t[k]);
      b.onclick = () => { t[k] = !t[k]; b.classList.toggle('on', t[k]); gains(); };
    });
    rows.append(r);
  }
  gains();
  document.getElementById('st').textContent = `${fmt(len)} · ${D.models}`;
  const btn = document.getElementById('play'); btn.disabled = false;
  btn.onclick = async () => {
    await ctx.resume();
    if (playing) { at += ctx.currentTime - start; stop(); btn.textContent = 'Play'; }
    else { play(at); btn.textContent = 'Pause'; }
    playing = !playing;
  };
  const pos = document.getElementById('pos');
  pos.oninput = () => { at = +pos.value; if (playing) play(at); };
  setInterval(() => {
    const now = playing ? at + ctx.currentTime - start : at;
    if (document.activeElement !== pos) pos.value = now;
    document.getElementById('time').textContent = fmt(now);
  }, 250);
})();
</script></body></html>
"""


def page(folder):
    """index.html beside the stems: all of them and the recording, in step, with Solo and Mute."""
    rep = json.loads((folder / "stems.json").read_text(encoding="utf-8"))
    names = [n for n in ("vocals", "guitar", "piano", "bass", "drums", "other") if (folder / f"{n}.wav").exists()]
    files = [[n.capitalize(), f"{n}.wav", False] for n in names]
    rec = next((real.CACHE / folder.name).glob("recording-*.wav"), None)
    if rec:
        import os
        files.append(["Recording", os.path.relpath(rec, folder).replace(os.sep, "/"), True])
    data = {"name": rep["name"], "files": files,
            "db": {n.capitalize(): f"{v['db']:+.1f} dB" for n, v in rep["stems"].items()},
            "models": "drums, bass, vocals: htdemucs_ft · guitar, piano: htdemucs_6s · other: the rest"}
    (folder / "index.html").write_text(PAGE.replace("__DATA__", json.dumps(data)), encoding="utf-8")


def title(url):
    import yt_dlp
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "skip_download": True}) as y:
        return y.extract_info(url, download=False)["title"]


def main():
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help"):
        sys.exit(__doc__)
    if a[0] == "--page":
        for f in OUT.iterdir():
            if (f / "stems.json").exists():
                page(f)
                print(f"{f / 'index.html'}")
        return
    url = a[0]
    name = a[a.index("--name") + 1] if "--name" in a else title(url)
    folder = OUT / run.slug(name)
    wav = real.download(url, real.CACHE / run.slug(name))
    import julius
    import soundfile as sf
    import torch
    audio, sr = sf.read(str(wav), dtype="float32", always_2d=True)
    x = torch.from_numpy(audio.T.copy())
    x = (x.repeat(2, 1) if x.shape[0] == 1 else x)[:2]
    if sr != SR:
        x = julius.resample_frac(x, sr, SR)
    print(f"{name}: splitting {x.shape[1] / SR:.0f} s (htdemucs_ft, then htdemucs_6s)...", flush=True)
    ft = separate("htdemucs_ft", x, SR)
    six = separate("htdemucs_6s", x, SR)
    stems = {"drums": ft["drums"], "bass": ft["bass"], "vocals": ft["vocals"], "guitar": six["guitar"], "piano": six["piano"]}
    stems["other"] = x - sum(stems.values())
    folder.mkdir(parents=True, exist_ok=True)
    rms = lambda v: float(torch.sqrt((v ** 2).mean()))
    db = lambda v: round(20 * np.log10(max(1e-9, rms(v) / rms(x))), 1)
    report = {"name": name, "url": url, "stems": {}}
    for n, v in stems.items():
        sf.write(str(folder / f"{n}.wav"), v.clamp(-1, 1).numpy().T, SR)
        report["stems"][n] = {"db": db(v)}
    # the five model stems against the recording: what's left over goes to "other"
    report["other_db"] = db(stems["other"])
    report["four_ft_leftover_db"] = db(x - sum(ft.values()))
    (folder / "stems.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    for n, v in report["stems"].items():
        print(f"  {n:7} {v['db']:+6.1f} dB against the recording")
    print(f"  htdemucs_ft's four add back up to the recording within {report['four_ft_leftover_db']} dB")
    page(folder)
    print(f"written to {folder}; listen: http://localhost:8421/tests/yt2gp5/out/stems/{folder.name}/")


if __name__ == "__main__":
    main()
