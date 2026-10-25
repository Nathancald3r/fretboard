"""Good stems of a recording: drums, bass, guitar, piano, vocals and the rest, as WAV files.

    python tests/yt2gp5/stems.py URL [--name NAME]     a YouTube link (the song's name is taken from its title)

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


def title(url):
    import yt_dlp
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "skip_download": True}) as y:
        return y.extract_info(url, download=False)["title"]


def main():
    a = sys.argv[1:]
    if not a or a[0] in ("-h", "--help"):
        sys.exit(__doc__)
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
    print(f"written to {folder}")


if __name__ == "__main__":
    main()
