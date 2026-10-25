"""The fair stem test: today's split (Kim Vocal 2 + MDX23C, then Demucs) against the RoFormer models.

    python tests/yt2gp5/sepcheck.py              both parts
    python tests/yt2gp5/sepcheck.py --part a     only the true-stem part
    python tests/yt2gp5/sepcheck.py --part b -k champion
    python tests/yt2gp5/sepcheck.py --page       listening pages for the part A songs split so far (out/sepcheck/)

Part A, true stems: the 5 cached synth songs (cache/<song>/mix.wav and true_*.wav, made by run.py). Each model's
stems are scored by SDR as run.stem_scores does (median of the 1-second windows where the instrument plays).
The instrumental's truth is the mix minus the true vocals. Synth audio is not a real recording, so Part A
ranks the models' skill on clean, known stems only.
Part B, real recordings: the 6 songs in out/listen. The guitar stem of each chain goes through basic-pitch at
the notebook's settings and is scored against the official tab's guitar notes (notecheck.truth / score).
Every model gets the same input and the same settings; MDX-C models (MDX23C and the RoFormers) run at 4
overlapping passes, as the notebook runs MDX23C. Separations are cached (cache/sepcheck/, cache/real/<song>/sepcheck/).
Writes out/sepcheck.json and out/sepcheck.md.
"""
import argparse
import gc
import json
import os
import shutil
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import notecheck  # noqa: E402
import real  # noqa: E402
import run  # noqa: E402
import stems as stemsmod  # noqa: E402

SR = 44100
UVR_MODELS = stemsmod.UVR_MODELS
# short name → (model file, its stems' names as audio-separator writes them)
SEP = {
    "kim": "Kim_Vocal_2.onnx",
    "mdx23c": "MDX23C-8KFFT-InstVoc_HQ.ckpt",
    "bs1297": "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
    "melkim": "vocals_mel_band_roformer.ckpt",
    "instv2": "melband_roformer_inst_v2.ckpt",
    "bssw": "BS-Roformer-SW.ckpt",
}
NOW = {"onset": 0.5, "frame": 0.25, "min_ms": 60, "min_amp": 0.0}  # the notebook's guitar settings
GPU_SHARE = [notecheck.GPU_SHARE]
TIMES = {}  # job → seconds (only work done in this run)


def setup(gpu):
    import torch
    if torch.cuda.is_available():
        torch.cuda.set_per_process_memory_fraction(gpu)  # the user's cap
    from audio_separator.separator.architectures import mdx_separator
    import onnx
    import onnx2torch

    def torch_load(self):  # Kim (ONNX) on the GPU through torch, as stems.uvr and the notebook do
        self.model_run = onnx2torch.convert(onnx.load(self.model_path)).to(self.torch_device).eval()
    mdx_separator.MDXSeparator.load_model = torch_load
    if not shutil.which("ffmpeg"):
        exe = UVR_MODELS / "bin" / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
        if not exe.exists():
            exe.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(real.ffmpeg(), exe)
        os.environ["PATH"] = str(exe.parent) + os.pathsep + os.environ["PATH"]


def read(p):
    import soundfile as sf
    a, _ = sf.read(str(p), dtype="float32", always_2d=True)
    return a.T


def write(p, a):
    import soundfile as sf
    p.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(p), np.clip(a.T, -1, 1), SR, subtype="FLOAT")


def uvr_all(name, wav, cache):
    """{stem: (2, n)} from one audio-separator model, cached as cache/<name>/<stem>.wav."""
    folder = cache / name
    if folder.exists() and any(folder.glob("*.wav")):
        return {p.stem: read(p) for p in folder.glob("*.wav")}
    import torch
    from audio_separator.separator import Separator
    work = cache / f"_{name}"
    work.mkdir(parents=True, exist_ok=True)
    t = time.time()
    sep = Separator(output_dir=str(work), model_file_dir=str(UVR_MODELS), output_format="WAV", sample_rate=SR,
                    log_level=40,
                    mdxc_params={"segment_size": 256, "override_model_segment_size": False, "batch_size": 1,
                                 "overlap": 4, "pitch_shift": 0})
    sep.load_model(model_filename=SEP[name])
    # the user's cap: the GPU busy only GPU_SHARE of the time (notecheck.throttle does this for Demucs)
    net = getattr(sep.model_instance, "model_run", None)
    if net is not None and hasattr(net, "forward") and torch.cuda.is_available():
        fwd = net.forward

        def slow(*x, **y):
            t0 = time.perf_counter()
            r = fwd(*x, **y)
            torch.cuda.synchronize()
            time.sleep((time.perf_counter() - t0) * (1 / GPU_SHARE[0] - 1))
            return r
        net.forward = slow
    out = {}
    for f in sep.separate(str(wav)):
        f = Path(f) if Path(f).is_absolute() else work / Path(f).name
        stem = f.name.split("_(")[-1].split(")")[0].lower()
        out[stem] = read(f)
        write(folder / f"{stem}.wav", out[stem])
    shutil.rmtree(work, ignore_errors=True)
    TIMES[f"{cache.name}:{name}"] = round(time.time() - t, 1)
    # the throttle makes a loop (net -> slow -> fwd -> net): free the model by hand, or the next one runs out of GPU memory
    if net is not None:
        net.__dict__.pop("forward", None)
    del sep, net
    gc.collect()
    torch.cuda.empty_cache() if torch.cuda.is_available() else None
    return out


def demucs(model, x, cache, tag, only=None):
    """{stem: (2, n)} from one Demucs model on x, cached as cache/<tag>/<stem>.wav."""
    folder = cache / tag
    if folder.exists() and any(folder.glob("*.wav")):
        return {p.stem: read(p) for p in folder.glob("*.wav")}
    import torch
    t = time.time()
    if only:  # one model of the htdemucs_ft bag
        from demucs.apply import apply_model
        from demucs.pretrained import get_model
        bag = get_model(model)
        m = bag.models[bag.sources.index(only)].eval()
        xt = torch.from_numpy(x)
        mean, std = xt.mean(0).mean(), xt.mean(0).std() + 1e-8
        with torch.no_grad():
            y = apply_model(m, ((xt - mean) / std)[None], device="cuda" if torch.cuda.is_available() else "cpu",
                            split=True, overlap=0.25, shifts=1, progress=False)[0]
        out = {only: (y[m.sources.index(only)] * std + mean).cpu().numpy()}
    else:
        out = {k: v.cpu().numpy() for k, v in stemsmod.separate(model, torch.from_numpy(x), SR).items()}
    for k, v in out.items():
        write(folder / f"{k}.wav", v)
    TIMES[f"{cache.name}:{tag}"] = round(time.time() - t, 1)
    torch.cuda.empty_cache() if torch.cuda.is_available() else None
    return out


def inst_of(name, wav, cache):
    s = uvr_all(name, wav, cache)
    return s.get("instrumental", s.get("other"))


# ---------------------------------------------------------------- part A: true stems
def part_a():
    res = {}
    for folder in sorted(p for p in run.CACHE.iterdir() if (p / "mix.wav").exists()):
        mix = read(folder / "mix.wav")
        true = {p.stem[5:]: read(p) for p in folder.glob("true_*.wav")}
        cache = run.CACHE / "sepcheck" / folder.name
        n = mix.shape[1]
        inst_true = mix - true["vocals"][:, :n] if "vocals" in true else mix
        r = res.setdefault(folder.name, {})
        score = lambda ref, est: run.stem_scores(ref.mean(0), est.mean(0)[:ref.shape[1]])[0]
        print(folder.name, flush=True)
        # vocals / instrumental
        for name in ("kim", "mdx23c", "bs1297", "melkim", "instv2"):
            s = uvr_all(name, folder / "mix.wav", cache)
            if "vocals" in s and "vocals" in true:
                r[f"vocals · {name}"] = score(true["vocals"], s["vocals"])
            if "instrumental" in s:
                r[f"instrumental · {name}"] = score(inst_true, s["instrumental"])
        # instruments: each chain's stems
        chains = {
            "6s on mdx23c (now)": lambda: demucs("htdemucs_6s", inst_of("mdx23c", folder / "mix.wav", cache), cache, "6s@mdx23c"),
            "ft bass on mdx23c (now)": lambda: demucs("htdemucs_ft", inst_of("mdx23c", folder / "mix.wav", cache), cache, "ftbass@mdx23c", only="bass"),
            "6s on bs1297": lambda: demucs("htdemucs_6s", inst_of("bs1297", folder / "mix.wav", cache), cache, "6s@bs1297"),
            "ft bass on bs1297": lambda: demucs("htdemucs_ft", inst_of("bs1297", folder / "mix.wav", cache), cache, "ftbass@bs1297", only="bass"),
            "bssw": lambda: uvr_all("bssw", folder / "mix.wav", cache),
        }
        for label, make in chains.items():
            s = make()
            for stem in ("drums", "bass", "guitar", "piano"):
                if stem in s and stem in true:
                    r[f"{stem} · {label}"] = score(true[stem], s[stem])
        print("  " + "  ".join(f"{k} {v}" for k, v in r.items()), flush=True)
    return res


# ---------------------------------------------------------------- part B: guitar notes on real songs
def guitar_f1(ns, wav_path, ref, others, cache):
    f = cache / "basic_pitch.npz"
    if f.exists():
        out = dict(np.load(f))
    else:
        from basic_pitch.inference import run_inference
        out = run_inference(str(wav_path), ns["BASIC_PITCH_MODEL"])
        np.savez_compressed(f, **out)
    ev = notecheck.events(out, NOW)
    return notecheck.score(ref, [(t, p) for t, p, a in ev], others)


def part_b(k):
    import soundfile as sf
    ns = run.load_notebook()
    res = {}
    for name in notecheck.songs(k):
        ref, others, wav, _ = notecheck.truth(run.OUT / "listen" / name)
        if not ref:
            continue
        cache = real.CACHE / name / "sepcheck"
        print(f"{name}: {len(ref)} tab guitar notes", flush=True)
        chains = {
            "6s on mdx23c (now)": lambda: demucs("htdemucs_6s", inst_of("mdx23c", wav, cache), cache, "6s@mdx23c")["guitar"],
            "6s on bs1297": lambda: demucs("htdemucs_6s", inst_of("bs1297", wav, cache), cache, "6s@bs1297")["guitar"],
            "bssw": lambda: uvr_all("bssw", wav, cache)["guitar"],
        }
        r = res.setdefault(name, {})
        for label, make in chains.items():
            g = make()
            tag = label.split(" (")[0].replace(" ", "_")
            p = cache / f"guitar-{tag}.wav"
            if not p.exists():
                sf.write(str(p), np.clip(g.T, -1, 1), SR, subtype="PCM_16")
            (cache / f"bp-{tag}").mkdir(exist_ok=True)
            r[label] = guitar_f1(ns, p, ref, others, cache / f"bp-{tag}")
            print(f"  {label:22s} F1 {r[label]['f1']:.3f} (recall {r[label]['recall']:.2f}, precision {r[label]['precision']:.2f})", flush=True)
    return res


def table(rows, cols):
    lines = ["| | " + " | ".join(cols) + " | mean |", "|---" * (len(cols) + 2) + "|"]
    for label, vals in rows.items():
        got = [v for v in vals if v is not None]
        mean = f"**{np.mean(got):.2f}**" if got else "–"
        lines.append(f"| {label} | " + " | ".join("–" if v is None else f"{v:.2f}" for v in vals) + f" | {mean} |")
    return lines


# ---------------------------------------------------------------- listening pages
SPLITS = {  # page folder → (title, {stem: cache folder}, the instrumental that "other" is the rest of)
    "true": ("The true stems", {}, None),
    "now": ("Now: Kim Vocal 2 + MDX23C, then Demucs", {"vocals": "kim", "guitar": "6s@mdx23c", "piano": "6s@mdx23c",
                                                     "drums": "6s@mdx23c", "bass": "ftbass@mdx23c"}, "mdx23c"),
    "bs1297": ("BS-Roformer 1297, then Demucs", {"vocals": "bs1297", "guitar": "6s@bs1297", "piano": "6s@bs1297",
                                                  "drums": "6s@bs1297", "bass": "ftbass@bs1297"}, "bs1297"),
    "bssw": ("BS-Roformer-SW (six stems)", {k: "bssw" for k in ("vocals", "guitar", "piano", "drums", "bass", "other")}, None),
}


def pages():
    """out/sepcheck/<song>/<split>/index.html: each split's stems in step (stems.py's page), SDR beside each."""
    import soundfile as sf
    hub = []
    for folder in sorted(p for p in run.CACHE.iterdir() if (p / "mix.wav").exists()):
        cache = run.CACHE / "sepcheck" / folder.name
        need = {c for _, m, _ in SPLITS.values() for c in m.values()}
        if not all((cache / c).is_dir() for c in need):
            continue  # not split yet
        mix = read(folder / "mix.wav")
        true = {p.stem[5:]: read(p) for p in folder.glob("true_*.wav")}
        song = run.OUT / "sepcheck" / folder.name
        links = []
        for key, (title, stems, inst) in SPLITS.items():
            out = song / key
            out.mkdir(parents=True, exist_ok=True)
            rel = lambda p: os.path.relpath(p, out).replace(os.sep, "/")
            files, db, got = [], {}, {}
            for stem in ("vocals", "guitar", "piano", "bass", "drums", "other"):
                src = folder / f"true_{stem}.wav" if key == "true" else (cache / stems[stem] / f"{stem}.wav" if stem in stems else None)
                if src is not None and src.exists():
                    got[stem] = read(src)
                    files.append([stem.capitalize(), rel(src), False])
            if inst and "other" not in got:  # the notebook's other: the instrumental minus the four
                a = read(cache / inst / "instrumental.wav")
                for k in ("guitar", "piano", "bass", "drums"):
                    if k in got:
                        n = min(a.shape[1], got[k].shape[1])
                        a = a[:, :n] - got[k][:, :n]
                sf.write(str(out / "other.wav"), np.clip(a.T, -1, 1), SR, subtype="PCM_16")
                got["other"] = a
                files.append(["Other", "other.wav", False])
            if key != "true":
                for stem, a in got.items():
                    if stem in true:
                        db[stem.capitalize()] = f"{run.stem_scores(true[stem].mean(0), a.mean(0)[:true[stem].shape[1]])[0]:.1f} dB SDR"
            files.append(["Mix", rel(folder / "mix.wav"), True])
            data = {"name": f"{folder.name.split('-')[0].replace('_', ' ').strip()} · {title}", "files": files, "db": db,
                    "models": title, "other": ["← All splits of this song", "../"]}
            (out / "index.html").write_text(stemsmod.PAGE.replace("__DATA__", json.dumps(data)), encoding="utf-8")
            links.append(f'<li><a href="{key}/">{title}</a></li>')
        (song / "index.html").write_text(
            '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>Splits</title><body style="font:15px/1.5 system-ui;max-width:640px;margin:0 auto;padding:16px">'
            f'<h1 style="font-size:20px">{folder.name.split("-")[0].replace("_", " ").strip()}</h1>'
            f'<p>Made-up (synth) song: the true stems are known, so each split can be heard against them.</p><ul>{"".join(links)}</ul>'
            '<p><a href="../">← All songs</a></p>', encoding="utf-8")
        hub.append(f'<li><a href="{folder.name}/">{folder.name.split("-")[0].replace("_", " ").strip()}</a></li>')
        print(song / "index.html", flush=True)
    (run.OUT / "sepcheck").mkdir(parents=True, exist_ok=True)
    (run.OUT / "sepcheck" / "index.html").write_text(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Stem test</title>'
        '<body style="font:15px/1.5 system-ui;max-width:640px;margin:0 auto;padding:16px"><h1 style="font-size:20px">Stem test: songs split so far</h1>'
        f'<ul>{"".join(hub)}</ul>', encoding="utf-8")


def main():
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--part", default="ab")
    ap.add_argument("-k", default="")
    ap.add_argument("--cpu", type=float, default=notecheck.CPU_SHARE)
    ap.add_argument("--gpu", type=float, default=notecheck.GPU_SHARE)
    ap.add_argument("--page", action="store_true", help="only write the listening pages")
    args = ap.parse_args()
    if args.page:
        return pages()
    cores = max(1, int((os.cpu_count() or 2) * args.cpu))
    notecheck.pin_cores(cores)
    import torch
    torch.set_num_threads(cores)
    GPU_SHARE[0] = args.gpu
    notecheck.throttle(args.gpu)
    setup(args.gpu)
    out_json = run.OUT / "sepcheck.json"
    data = json.loads(out_json.read_text(encoding="utf-8")) if out_json.exists() else {}
    if "a" in args.part:
        data["a"] = part_a()
    if "b" in args.part:
        data["b"] = {**data.get("b", {}), **part_b(args.k)}
    data.setdefault("times", {}).update(TIMES)
    out_json.write_text(json.dumps(data, indent=1), encoding="utf-8")

    md = ["# Stem models: today's split vs RoFormer", ""]
    if "a" in data:
        songs = list(data["a"])
        md += ["## A. True stems (synth songs), SDR dB, higher is better", "",
               "Songs: " + ", ".join(s.split("-")[0].strip("_") + "…" for s in songs), ""]
        labels = sorted({l for s in songs for l in data["a"][s]})
        md += table({l: [data["a"][s].get(l) for s in songs] for l in labels}, [f"{i + 1}" for i in range(len(songs))])
        md.append("")
    if "b" in data:
        songs = list(data["b"])
        md += ["## B. Real recordings: guitar notes vs the official tab, F1 (1 = perfect)", "",
               "Songs: " + ", ".join(songs), ""]
        labels = list(dict.fromkeys(l for s in songs for l in data["b"][s]))
        md += table({l: [data["b"][s].get(l, {}).get("f1") for s in songs] for l in labels}, [f"{i + 1}" for i in range(len(songs))])
        md.append("")
    md += ["## Time per separation (s, this PC, Quadro T1000)", ""]
    md += [f"- {k}: {v}" for k, v in data["times"].items()]
    (run.OUT / "sepcheck.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    print("\n".join(md))


if __name__ == "__main__":
    main()
