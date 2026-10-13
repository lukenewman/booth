"""
Blind listening test for beat-grid disagreements (BOO-88). For each track where
a tracker and rekordbox agree on tempo but not on where the beat falls, renders
two short clips with a click on every beat, one per grid, labelled A/B at random,
plus a page to play them and record which sits on the beat.

    python make_listening.py TRUTH.jsonl SCORES.jsonl OUTDIR [--n 12] [--seconds 20]

SCORES is beatgrid-score.ts --dump output (calibrated). The answer key goes in
OUTDIR/key.json; the page never reads it.
"""
import argparse, html, json, os, random, subprocess
import numpy as np

SR = 44100
# The decoder offset the scorer measured: rekordbox's beat times minus ffmpeg's.
SHIFT = {"mp3": 44.7, "m4a": 46.9}


def click(sr=SR):
    t = np.arange(int(0.025 * sr)) / sr
    return (np.sin(2 * np.pi * 1600 * t) * np.exp(-t * 180)).astype(np.float32)


def render(path, start_s, seconds, beats_ms, out):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", str(start_s), "-t", str(seconds), "-i", path,
                          "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"], capture_output=True, check=True).stdout
    y = np.frombuffer(raw, np.float32).reshape(-1, 2).copy()
    y *= 0.7
    c = click() * 0.6
    for b in beats_ms:
        i = int(round((b / 1000 - start_s) * SR))
        if 0 <= i < len(y) - len(c):
            y[i:i + len(c)] += c[:, None]
    np.clip(y, -1, 1, out=y)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "-",
                    "-b:a", "192k", out], input=y.tobytes(), check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("truth"); ap.add_argument("scores"); ap.add_argument("outdir")
    ap.add_argument("--n", type=int, default=12); ap.add_argument("--seconds", type=float, default=20)
    a = ap.parse_args()
    truth = {json.loads(l)["id"]: json.loads(l) for l in open(a.truth)}
    scores = [json.loads(l) for l in open(a.scores)]
    rng = random.Random(7)
    picks = []
    for s in scores:
        if s["tempo"] not in ("exact", "close") or abs(s["offsetMs"]) < 25:
            continue
        t = truth[s["id"]]
        frac = s["offsetMs"] / (60000 / t["bpm"])
        picks.append((abs(abs(frac) - 0.5) < 0.1, frac, s, t))
    # Half the list from half-beat disagreements, the rest from smaller ones.
    half = [p for p in picks if p[0]]; other = [p for p in picks if not p[0]]
    rng.shuffle(half); rng.shuffle(other)
    chosen = half[: a.n // 2] + other[: a.n - min(len(half), a.n // 2)]
    rng.shuffle(chosen)
    os.makedirs(a.outdir, exist_ok=True)
    key, rows = [], []
    for i, (_, frac, s, t) in enumerate(chosen, 1):
        fmt = t["path"].rsplit(".", 1)[1].lower()
        shift = SHIFT.get(fmt, 0)
        rb = [b - shift for b in t["beatsMs"]]
        bt = [b - s["offsetMs"] for b in rb]
        # A stretch a third of the way in, past most intros.
        start = round(t["beatsMs"][len(t["beatsMs"]) // 3] / 1000 - 2, 1)
        grids = [("rekordbox", rb), ("beat_this", bt)]
        rng.shuffle(grids)
        for label, (who, beats) in zip("AB", grids):
            render(t["path"], start, a.seconds, beats, os.path.join(a.outdir, f"{i:02d}{label}.mp3"))
        key.append({"n": i, "label": t["label"], "A": grids[0][0], "B": grids[1][0],
                    "offsetBeats": round(frac, 2), "startS": start})
        rows.append((i, t["label"], t["bpm"]))
        print(f"{i:02d} {t['label']}")
    json.dump(key, open(os.path.join(a.outdir, "key.json"), "w"), indent=1)
    with open(os.path.join(a.outdir, "index.html"), "w") as f:
        f.write(PAGE.replace("%ROWS%", "\n".join(
            f'<tr data-n="{n}"><td>{n}</td><td>{html.escape(label)}<br><small>{bpm:g} BPM</small></td>'
            f'<td><audio controls preload="none" src="{n:02d}A.mp3"></audio></td>'
            f'<td><audio controls preload="none" src="{n:02d}B.mp3"></audio></td>'
            f'<td class="v">' + "".join(f'<label><input type="radio" name="v{n}" value="{v}"> {v}</label>'
                                         for v in ("A", "B", "both", "neither")) + "</td></tr>"
            for n, label, bpm in rows)))


PAGE = """<!doctype html><meta charset="utf-8"><title>Beat grid listening</title>
<style>
body{font:15px/1.4 -apple-system,system-ui,sans-serif;margin:24px;background:#111;color:#eee}
table{border-collapse:collapse;width:100%}td{padding:10px 8px;border-bottom:1px solid #333;vertical-align:middle}
audio{width:240px}small{color:#999}.v label{margin-right:10px;white-space:nowrap}
button{font:inherit;padding:8px 14px;margin-top:16px}textarea{width:100%;height:120px;margin-top:8px;background:#222;color:#eee}
</style>
<h2>Which clicks sit on the beat?</h2>
<p>Each track has two 20-second clips with a click on every beat, from two different grids, in random order.
Pick the one that's on the beat: "both" if you can't tell them apart, "neither" if both are off.</p>
<table>%ROWS%</table>
<button id="copy">Show answers to paste back</button><textarea id="out" readonly></textarea>
<script>
const save=()=>{const v={};document.querySelectorAll('input:checked').forEach(i=>v[i.name.slice(1)]=i.value);
try{localStorage.setItem('verdicts',JSON.stringify(v))}catch{};return v};
try{const v=JSON.parse(localStorage.getItem('verdicts')||'{}');for(const[n,x]of Object.entries(v)){const i=document.querySelector(`input[name=v${n}][value="${x}"]`);if(i)i.checked=true}}catch{}
document.addEventListener('change',save);
document.getElementById('copy').onclick=()=>{document.getElementById('out').value=JSON.stringify(save())};
document.addEventListener('play',e=>document.querySelectorAll('audio').forEach(a=>{if(a!==e.target)a.pause()}),true);
</script>
"""

if __name__ == "__main__":
    main()
