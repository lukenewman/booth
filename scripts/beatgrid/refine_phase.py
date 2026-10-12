"""
Nudges a tracker's beats by one whole-track shift (±25 ms, 1 ms steps) to where
the onset envelope is strongest, to get past the tracker's frame resolution
(beat_this works in 20 ms frames). Writes a new results file.

    python refine_phase.py TRUTH.jsonl RESULTS.jsonl OUT.jsonl [--band kick|full]
"""
import argparse, json, subprocess
from concurrent.futures import ProcessPoolExecutor
import numpy as np

SR, HOP = 22050, 32


def envelope(path, band):
    import librosa
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    y = np.frombuffer(raw, np.float32)
    S = np.abs(librosa.stft(y, n_fft=1024, hop_length=HOP))
    f = librosa.fft_frequencies(sr=SR, n_fft=1024)
    rows = f < 150 if band == "kick" else f > 0
    x = np.log1p(S[rows])
    return np.concatenate([[0], np.maximum(0, np.diff(x, axis=1)).sum(0)])


def work(job):
    path, r, band = job
    if r.get("error") or not r.get("beatsMs"):
        return r
    env = envelope(path, band)
    beats = np.array(r["beatsMs"])
    fps = SR / HOP
    best, best_ms = -1, 0
    for ms in range(-25, 26):
        idx = np.round((beats + ms) / 1000 * fps).astype(int)
        idx = idx[(idx >= 0) & (idx < len(env))]
        v = env[idx].mean()
        if v > best:
            best, best_ms = v, ms
    return {**r, "beatsMs": [round(b + best_ms, 1) for b in r["beatsMs"]],
            "downbeatsMs": [round(b + best_ms, 1) for b in r.get("downbeatsMs", [])], "shiftMs": best_ms}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("truth"); ap.add_argument("results"); ap.add_argument("out")
    ap.add_argument("--band", default="full")
    a = ap.parse_args()
    paths = {json.loads(l)["id"]: json.loads(l)["path"] for l in open(a.truth)}
    results = [json.loads(l) for l in open(a.results)]
    with ProcessPoolExecutor(8) as pool, open(a.out, "w") as f:
        for r in pool.map(work, [(paths[r["id"]], r, a.band) for r in results], chunksize=4):
            f.write(json.dumps(r) + "\n")


if __name__ == "__main__":
    main()
