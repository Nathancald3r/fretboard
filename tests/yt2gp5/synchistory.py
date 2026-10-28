"""The sync history and its dashboard (used by syncreport.py; nothing to run here).

    python tests/yt2gp5/syncreport.py --save "what changed"   keep this moment in the history, then redraw the dashboard
    python tests/yt2gp5/syncreport.py --open                  redraw the dashboard from the history and open it

The history is tests/yt2gp5/history/sync-history.json (committed with the code, so it grows with the project).
Each snapshot keeps: the time, your label, the git commit, the tuned constants of wavefit.py, the benchmark ladder
(good / ok / bad / declined per step, train / val), the breakdowns, the worst cases, and the gate's verdict for each
real song. A save that changes nothing (same numbers, same constants) is not added twice.
The dashboard, tests/yt2gp5/history/dashboard.html, is one page with no scripts and no downloads: open it in any browser.
"""
import collections
import html
import json
import re
import subprocess
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
HIST_DIR = HERE / "history"
HIST = HIST_DIR / "sync-history.json"
DASH = HIST_DIR / "dashboard.html"
ROOT = HERE.parent.parent


def constants():
    """The numeric ALL_CAPS settings of wavefit.py, read from the text."""
    out = {}
    for line in (HERE / "wavefit.py").read_text(encoding="utf-8", errors="replace").splitlines():
        m = re.match(r"^([A-Z][A-Z0-9_]*) = (-?[\d.]+(?:e-?\d+)?)\b", line)
        if m:
            try:
                out[m.group(1)] = float(m.group(2))
            except ValueError:
                pass
    return out


def git_state():
    def run(*a):
        try:
            return subprocess.run(["git", *a], cwd=ROOT, capture_output=True, text=True, timeout=20).stdout.strip()
        except Exception:
            return ""
    return {"commit": run("rev-parse", "--short", "HEAD"),
            "dirty": bool(run("status", "--porcelain", "--", "tests/yt2gp5/wavefit.py", "tests/yt2gp5/truthbench.py", "tests/yt2gp5/qa.py", "tests/yt2gp5/syncqa.py"))}


def slim(c):
    return None if not c else {k: c[k] for k in ("n", "good", "ok", "bad", "none")}


def snapshot(last, label, groups_of, cls, counts):
    """last = syncreport.LAST. groups_of(rows, key, order) and counts/cls are syncreport's own."""
    ladder = last["ladder"]
    steps = []
    for s in ladder:
        sp = last["split"].get(s["name"])
        steps.append({"name": s["name"], "adds": s["adds"], "src": s["src"], "c": slim(s["c"]),
                      "train": slim(sp["train"]) if sp else None, "val": slim(sp["val"]) if sp else None,
                      "far": slim(s.get("far"))})
    from syncreport import CLOCKS, CONTENTS, STARTS  # noqa: E402
    groups = {}
    for s in ladder:
        if not s["rows"]:
            continue
        g = {}
        for key, order in (("clock", CLOCKS), ("content", CONTENTS), ("start", STARTS)):
            rows = (s["rows"] + s["far_rows"]) if key == "start" else s["rows"]
            g[key] = {k: slim(v) for k, v in groups_of(rows, key, order).items()}
        groups[s["name"]] = g
    final = next((s for s in reversed(ladder) if s["rows"]), None)
    worst = []
    if final:
        pool = final["rows"] + final["far_rows"]
        for r in sorted(pool, key=lambda r: (r["worst"] is not None, -(r["worst"] or 0)))[:10]:
            worst.append({"song": r["song"], "clock": r["clock"], "content": r["content"], "start": r["start"],
                          "worst": None if r["worst"] is None else round(r["worst"]), "step": final["name"]})
    real = []
    for r in last["real"] or []:
        if "now" not in r:
            continue
        real.append({"name": r["name"].replace(" (official)", ""), "before": r["before"]["verdict"], "now": r["now"]["verdict"],
                     "drift_before": r["before"]["drift"], "drift": r["now"]["drift"], "first": r["now"]["first"], "backup": bool(r["backup"])})
    return {"time": time.strftime("%Y-%m-%d %H:%M"), "label": label or "", **git_state(), "constants": constants(),
            "steps": steps, "groups": groups, "worst": worst, "real": real}


def fingerprint(s):
    return json.dumps([[st["name"], st["c"]] for st in s["steps"]] + [s["constants"], [(r["name"], r["now"], r["drift"]) for r in s["real"]]], sort_keys=True)


def load():
    try:
        return json.loads(HIST.read_text(encoding="utf-8"))
    except Exception:
        return []


def save(snap):
    """Append unless nothing changed since the last snapshot. Returns (added, why)."""
    hist = load()
    if hist and fingerprint(hist[-1]) == fingerprint(snap):
        return False, f"same numbers and settings as the last snapshot ({hist[-1]['time']}), not added again"
    HIST_DIR.mkdir(exist_ok=True)
    hist.append(snap)
    HIST.write_text(json.dumps(hist, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    return True, f"snapshot {len(hist)} saved in {HIST}"


# ---------- the page ----------

E = html.escape
COL = {"good": "var(--good)", "ok": "var(--ok)", "bad": "var(--bad)", "none": "var(--none)"}
NAMES = {"good": "good (every bar within 50 ms)", "ok": "ok (within 150 ms)", "bad": "bad", "none": "declined (gate leaves the file alone)"}


def pc(a, n):
    return 100 * a / n if n else 0


def final_step(s):
    return next((st for st in reversed(s["steps"]) if st["c"]), None)


def seg_bar(c, width=520, h=22, label=True):
    """One stacked bar for a good/ok/bad/declined count."""
    if not c:
        return '<span class="muted">no stored result</span>'
    n = c["n"]
    x, parts = 0, []
    for k in ("good", "ok", "bad", "none"):
        w = width * c[k] / n if n else 0
        if w <= 0:
            continue
        txt = f'<text x="{x + w / 2:.1f}" y="{h / 2 + 4:.1f}" text-anchor="middle" class="bt">{c[k]}</text>' if label and w >= 24 else ""
        parts.append(f'<g><title>{NAMES[k]}: {c[k]} of {n}</title><rect x="{x:.1f}" y="0" width="{max(w, 0.5):.1f}" height="{h}" fill="{COL[k]}"/>{txt}</g>')
        x += w
    return f'<svg viewBox="0 0 {width} {h}" width="100%" height="{h}" preserveAspectRatio="none" role="img">{"".join(parts)}</svg>'


def delta_chip(v, better_up=True, unit=""):
    if v is None:
        return ""
    if v == 0:
        return '<span class="chip flat">no change</span>'
    good = (v > 0) == better_up
    return f'<span class="chip {"up" if good else "down"}">{v:+.4g}{unit}</span>'


def tile(title, value, sub, d=""):
    return f'<div class="tile"><div class="tt">{E(title)}</div><div class="tv">{value} {d}</div><div class="ts">{E(sub)}</div></div>'


def ladder_section(s, prev):
    rows = []
    last = None
    for st in s["steps"]:
        c = st["c"]
        if not c:
            rows.append(f'<tr><td class="nm">{E(st["name"])}</td><td colspan="3" class="muted">no stored result</td></tr>')
            continue
        d = delta_chip(c["good"] - last["good"]) if last else ""
        rows.append(f'<tr><td class="nm" title="{E(st["adds"])}">{E(st["name"])}</td><td class="bar">{seg_bar(c)}</td>'
                    f'<td class="num">{pc(c["good"], c["n"]):.0f}% good</td><td>{d}</td></tr>')
        last = c
    return "".join(rows)


def line_chart(title, series, xs, ymax=None, fmt="{:.0f}", unit="", w=420, h=220):
    """series: [(name, colour, [value or None per x])]. Plain SVG lines with a dot and the number on each point."""
    L, R, T, B = 44, 22, 28, 40
    vals = [v for _, _, vv in series for v in vv if v is not None]
    top = ymax if ymax is not None else (max(vals) * 1.15 if vals and max(vals) > 0 else 1)
    n = len(xs)
    px = lambda i: L + ((w - L - R) * (i / (n - 1) if n > 1 else 0.5))
    py = lambda v: T + (h - T - B) * (1 - v / top)
    g = [f'<text x="{L}" y="14" class="ct">{E(title)}</text>']
    for t in range(0, 5):
        v = top * t / 4
        g.append(f'<line x1="{L}" x2="{w - R}" y1="{py(v):.1f}" y2="{py(v):.1f}" class="grid"/><text x="{L - 6}" y="{py(v) + 4:.1f}" text-anchor="end" class="ax">{fmt.format(v)}{unit}</text>')
    for i, x in enumerate(xs):
        g.append(f'<text x="{px(i):.1f}" y="{h - 18}" text-anchor="middle" class="ax">{E(x[0])}</text><text x="{px(i):.1f}" y="{h - 5}" text-anchor="middle" class="ax2">{E(x[1])}</text>')
    for name, colr, vv in series:
        pts = [(px(i), py(v), v) for i, v in enumerate(vv) if v is not None]
        if len(pts) > 1:
            g.append(f'<polyline points="{" ".join(f"{a:.1f},{b:.1f}" for a, b, _ in pts)}" fill="none" stroke="{colr}" stroke-width="2.5"/>')
        for a, b, v in pts:
            g.append(f'<circle cx="{a:.1f}" cy="{b:.1f}" r="4" fill="{colr}"><title>{E(name)}: {fmt.format(v)}{unit}</title></circle>'
                     f'<text x="{a:.1f}" y="{b - 8:.1f}" text-anchor="middle" class="pt" fill="{colr}">{fmt.format(v)}{unit}</text>')
    leg = " ".join(f'<span class="lg"><i style="background:{c}"></i>{E(n)}</span>' for n, c, _ in series)
    return f'<div class="chart"><svg viewBox="0 0 {w} {h}" width="100%" role="img">{"".join(g)}</svg><div class="legend">{leg}</div></div>'


def chip_v(v):
    cls = {"PASS": "vp", "LISTEN": "vl", "FAIL": "vf"}.get(v, "vn")
    return f'<span class="vc {cls}">{E(v or "-")}</span>'


def render(snaps, unsaved=False):
    cur = snaps[-1]
    prev = snaps[-2] if len(snaps) > 1 else None
    f, pf = final_step(cur), (final_step(prev) if prev else None)
    plain = cur["steps"][0]["c"]
    xs = [(s["time"][5:10], (s["label"] or s["commit"] or "")[:14]) for s in snaps]
    tot = lambda s, k: sum(1 for r in s["real"] if r["now"] == k)

    tiles = []
    if f:
        c = f["c"]
        pg = pc(c["good"], c["n"])
        tiles.append(tile("Benchmark: fits within 50 ms", f"{pg:.0f}%", f"{c['good']} of {c['n']} ({f['name']})",
                          delta_chip(round(pg - pc(pf["c"]["good"], pf["c"]["n"]), 1), True, " pts") if pf else ""))
        tiles.append(tile("Benchmark: bad fits", f"{c['bad']}", f"was {plain['bad']} with plain wavefit", delta_chip(c["bad"] - pf["c"]["bad"], False) if pf else ""))
        tiles.append(tile("Benchmark: declined", f"{c['none']}", f"was {plain['none']} with plain wavefit", delta_chip(c["none"] - pf["c"]["none"], False) if pf else ""))
    if cur["real"]:
        tiles.append(tile("Real songs: PASS", f"{tot(cur, 'PASS')} / {len(cur['real'])}", f"LISTEN {tot(cur, 'LISTEN')} · FAIL {tot(cur, 'FAIL')}",
                          delta_chip(tot(cur, "PASS") - tot(prev, "PASS")) if prev and prev["real"] else ""))

    # history charts
    good_pct = [(pc(final_step(s)["c"]["good"], final_step(s)["c"]["n"]) if final_step(s) else None) for s in snaps]
    badn = [(final_step(s)["c"]["bad"] + final_step(s)["c"]["none"] if final_step(s) else None) for s in snaps]
    charts = line_chart("Benchmark: fits within 50 ms (%)", [("good %", "var(--good)", good_pct)], xs, ymax=100, unit="%") + \
        line_chart("Benchmark: bad + declined fits (fewer is better)", [("bad + declined", "var(--bad)", badn)], xs) + \
        line_chart("Real songs by the gate", [("PASS", "var(--good)", [tot(s, "PASS") if s["real"] else None for s in snaps]),
                                              ("LISTEN", "var(--ok)", [tot(s, "LISTEN") if s["real"] else None for s in snaps]),
                                              ("FAIL", "var(--bad)", [tot(s, "FAIL") if s["real"] else None for s in snaps])], xs)

    # train / val
    tv = []
    for st in cur["steps"]:
        t, v = st["train"], st["val"]
        if not (t and v):
            tv.append(f'<tr><td class="nm">{E(st["name"])}</td><td colspan="3" class="muted">counts only: no train/val</td></tr>')
            continue
        gt, gv = pc(t["good"], t["n"]), pc(v["good"], v["n"])
        tv.append(f'<tr><td class="nm">{E(st["name"])}</td><td class="num">train {gt:.0f}%</td><td class="num">val {gv:.0f}%</td>'
                  f'<td><div class="pair"><i style="width:{gt:.0f}%;background:var(--good)"></i><i style="width:{gv:.0f}%;background:var(--val)"></i></div></td>'
                  f'<td class="num">{gv - gt:+.0f} pts</td></tr>')

    # breakdowns: plain vs the final step
    br = []
    gp, gf = cur["groups"].get(cur["steps"][0]["name"]), (cur["groups"].get(f["name"]) if f else None)
    for key, title in (("clock", "By clock (how the tab's tempo differs)"), ("content", "By what the tab holds"), ("start", "By how far off the start was")):
        rows = []
        for k in (gf or {}).get(key, {}):
            a = (gp or {}).get(key, {}).get(k)
            rows.append(f'<tr><td class="nm">{E(k)}</td><td class="bar">{seg_bar(a, 300, 14, False) if a else ""}{seg_bar(gf[key][k], 300, 18)}</td>'
                        f'<td class="num">{pc(gf[key][k]["good"], gf[key][k]["n"]):.0f}% good</td></tr>')
        br.append(f'<h3>{title}</h3><table class="t">{"".join(rows)}</table>')

    worst = "".join(f'<tr><td>{E(w["song"])}</td><td>{E(w["clock"])}</td><td>{E(w["content"])}</td><td>{E(w["start"])}</td>'
                    f'<td class="num">{"declined" if w["worst"] is None else str(w["worst"]) + " ms"}</td></tr>' for w in cur["worst"])

    # real songs: now, plus a verdict history per song
    names = sorted({r["name"] for s in snaps for r in s["real"]})
    head = "".join(f'<th title="{E(s["label"])}">{E(s["time"][5:10])}</th>' for s in snaps)
    real_rows = []
    for nm in names:
        cells, last_r = [], None
        for s in snaps:
            r = next((r for r in s["real"] if r["name"] == nm), None)
            cells.append(f'<td>{chip_v(r["now"]) if r else ""}</td>')
            if r:
                last_r = r
        was = f'{chip_v(last_r["before"])} → ' if last_r and last_r["backup"] else ""
        extra = f'<span class="muted">{last_r["drift_before"]}→{last_r["drift"]} drift bars</span>' if last_r and last_r["backup"] else f'<span class="muted">{last_r["drift"]} drift bars</span>'
        real_rows.append(f'<tr><td class="nm">{E(nm)}</td>{"".join(cells)}<td>{was}{extra}</td></tr>')
    real_html = f'<table class="t"><tr><th></th>{head}<th>wavefit changed it</th></tr>{"".join(real_rows)}</table>' if names else '<p class="muted">no real-song verdicts in this snapshot</p>'

    # snapshot log + what constants changed
    log = []
    for i, s in enumerate(snaps):
        fs = final_step(s)
        ch = ""
        if i:
            old = snaps[i - 1]["constants"]
            diff = [f"{k} {old[k]:g}→{v:g}" if k in old else f"{k} new {v:g}" for k, v in s["constants"].items() if old.get(k) != v]
            ch = ", ".join(diff[:6]) + (" …" if len(diff) > 6 else "")
        log.append(f'<tr><td>{E(s["time"])}</td><td>{E(s["label"])}</td><td><code>{E(s["commit"])}{"*" if s.get("dirty") else ""}</code></td>'
                   f'<td class="num">{pc(fs["c"]["good"], fs["c"]["n"]):.0f}%</td><td class="num">{fs["c"]["bad"]}</td><td class="num">{fs["c"]["none"]}</td>'
                   f'<td class="num">{tot(s, "PASS")}/{tot(s, "LISTEN")}/{tot(s, "FAIL")}</td><td class="muted">{E(ch)}</td></tr>' if fs else "")
    note = ' <span class="chip flat">includes unsaved numbers from now</span>' if unsaved else ""

    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sync history</title><style>
:root{{--bg:#f6f7f9;--card:#fff;--fg:#1c2330;--mut:#6b7585;--line:#e3e6ec;--good:#2f9e5f;--ok:#e0a526;--bad:#d64545;--none:#98a1b0;--val:#3b82c4;--up:#1f8a4c;--down:#c0392b}}
@media (prefers-color-scheme:dark){{:root{{--bg:#12161d;--card:#1b212b;--fg:#e8ebf0;--mut:#8b95a5;--line:#2a323f;--good:#46b97a;--ok:#e7b547;--bad:#e46a6a;--none:#6f7886;--val:#5aa0e0;--up:#46b97a;--down:#e46a6a}}}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,Segoe UI,sans-serif;padding:20px 16px 60px}}
main{{max-width:1040px;margin:0 auto}}h1{{font-size:24px;margin:0 0 4px}}h2{{font-size:18px;margin:34px 0 10px}}h3{{font-size:14px;margin:18px 0 6px;color:var(--mut)}}
.sub{{color:var(--mut);margin:0 0 18px}}.muted{{color:var(--mut);font-size:13px}}
.tiles{{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}}
.card{{overflow-x:auto}}.tile,.card{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}}
.tt{{font-size:13px;color:var(--mut)}}.tv{{font-size:30px;font-weight:650;margin:2px 0}}.ts{{font-size:13px;color:var(--mut)}}
.chip{{font-size:12px;font-weight:600;border-radius:99px;padding:2px 8px;vertical-align:middle}}.up{{background:color-mix(in srgb,var(--up) 18%,transparent);color:var(--up)}}
.down{{background:color-mix(in srgb,var(--down) 18%,transparent);color:var(--down)}}.flat{{background:var(--line);color:var(--mut)}}
table.t{{width:100%;border-collapse:collapse}}.t td,.t th{{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle;font-size:14px}}
.t th{{font-size:12px;color:var(--mut);font-weight:600}}.nm{{white-space:nowrap;width:1%;font-weight:600}}.num{{text-align:right!important;white-space:nowrap;font-variant-numeric:tabular-nums}}
.bar{{min-width:240px}}.bar svg{{display:block;border-radius:4px;margin:2px 0}}.bt{{font-size:11px;fill:#fff;font-weight:700}}
.charts{{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px}}.chart{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px}}
.ct{{font-size:13px;fill:var(--mut);font-weight:600}}.ax{{font-size:12px;fill:var(--mut)}}.ax2{{font-size:10px;fill:var(--mut)}}.pt{{font-size:13px;font-weight:700}}.grid{{stroke:var(--line);stroke-width:1}}
.legend{{font-size:12px;color:var(--mut);padding:0 6px}}.lg{{margin-right:12px}}.lg i{{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px}}
.key{{display:flex;flex-wrap:wrap;gap:14px;font-size:13px;color:var(--mut);margin:8px 0}}.key i{{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:5px;vertical-align:-1px}}
.pair{{width:160px}}.pair i{{display:block;height:7px;border-radius:3px;margin:2px 0}}
.vc{{font-size:11px;font-weight:700;border-radius:5px;padding:2px 6px}}.vp{{background:var(--good);color:#fff}}.vl{{background:var(--ok);color:#222}}.vf{{background:var(--bad);color:#fff}}.vn{{background:var(--line)}}
code{{font-size:12px}}.two{{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,440px),1fr));gap:16px}}.two .bar{{min-width:200px}}
@media (max-width:560px){{.tv{{font-size:24px}}.bar{{min-width:150px}}}}
</style></head><body><main>
<h1>Sync history</h1>
<p class="sub">How well a song's tab lines up with its recording, measured on a benchmark with known answers and on your real songs. Latest: {E(cur["time"])}{(" · " + E(cur["label"])) if cur["label"] else ""}.{note}</p>
<div class="tiles">{"".join(tiles)}</div>
<div class="key"><span><i style="background:var(--good)"></i>good: every bar within 50 ms</span><span><i style="background:var(--ok)"></i>ok: within 150 ms</span><span><i style="background:var(--bad)"></i>bad: worse</span><span><i style="background:var(--none)"></i>declined: the fit gave up, the file is left alone</span></div>

<h2>Over time</h2>
<div class="charts">{charts}</div>
<p class="muted">One point per saved snapshot (save one after each change with <code>python tests/yt2gp5/syncreport.py --save "what changed"</code>).{" Only one snapshot so far, so these are single dots." if len(snaps) == 1 else ""}</p>

<h2>Each improvement on the benchmark</h2>
<div class="card"><table class="t">{ladder_section(cur, prev)}</table>
<p class="muted">288 fits per step: 16 songs × 9 cases (steady, slow 3%, fast 3%, a tempo step, a slow intro and ending; full, partial or wrong tab) × a good or bad starting line. Hover a step for what it adds.</p></div>

<h2>Is it overfitting? Train songs vs val songs</h2>
<div class="card"><table class="t">{"".join(tv)}</table>
<p class="muted">Settings were tuned on the train songs. Val close to train means the gain is real, not tuned to those songs.</p></div>

<h2>Where it is strong and weak</h2>
<div class="card"><p class="muted">Thin bar: plain wavefit. Thick bar: {E(f["name"]) if f else "latest"}.</p><div class="two">{"".join(f"<div>{b}</div>" for b in br)}</div></div>

<h2>The 10 worst cases left</h2>
<div class="card"><table class="t"><tr><th>song</th><th>clock</th><th>tab</th><th>start</th><th class="num">worst bar</th></tr>{worst}</table></div>

<h2>Real songs (the gate's verdict)</h2>
<div class="card">{real_html}<p class="muted">Columns are snapshots. “wavefit changed it” shows the verdict before → now for the songs wavefit rewrote.</p></div>

<h2>Snapshots</h2>
<div class="card" style="overflow-x:auto"><table class="t"><tr><th>time</th><th>label</th><th>commit</th><th class="num">good</th><th class="num">bad</th><th class="num">declined</th><th class="num">PASS/LISTEN/FAIL</th><th>settings changed</th></tr>{"".join(log)}</table>
<p class="muted">* = code was changed but not committed when the snapshot was taken.</p></div>
</main></body></html>
"""


def write_dashboard(snaps, unsaved=False):
    HIST_DIR.mkdir(exist_ok=True)
    DASH.write_text(render(snaps, unsaved), encoding="utf-8", newline="\n")
    return DASH
