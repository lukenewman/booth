"""
Runs candidate beat trackers over a beatgrid-truth.ts file (BOO-88) and writes
one JSON-lines file per tracker: {"id", "beatsMs", "downbeatsMs", "seconds"}.

    python run_trackers.py TRUTH.jsonl OUTDIR [--trackers beat_this,essentia,librosa] [--jobs N]

Exploration tooling, not part of the app: it needs a Python env with librosa,
essentia, torch and beat_this (github.com/CPJKU/beat_this).
"""
import argparse, json, os, sys, time
from concurrent.futures import ProcessPoolExecutor

SR = 44100


def load(path, sr):
    """Decodes with ffmpeg, which reads every format the library holds (m4a included)."""
    import subprocess, numpy as np
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def run_librosa(path):
    import librosa
    y = load(path, 22050)
    _, beats = librosa.beat.beat_track(y=y, sr=22050, units="time", start_bpm=124)
    return list(beats), []


def run_essentia(path):
    import essentia.standard as es
    y = load(path, SR)
    _, beats, _, _, _ = es.RhythmExtractor2013(method="multifeature")(y)
    return list(beats), []


_bt = None


def run_beat_this(path):
    global _bt
    from beat_this.inference import Audio2Beats
    if _bt is None:
        _bt = Audio2Beats(checkpoint_path="final0", device="cpu", dbn=False)
    beats, downbeats = _bt(load(path, 22050), 22050)
    return list(beats), list(downbeats)


TRACKERS = {"librosa": run_librosa, "essentia": run_essentia, "beat_this": run_beat_this}


def work(job):
    name, t = job
    start = time.time()
    try:
        beats, downs = TRACKERS[name](t["path"])
        return {"id": t["id"], "beatsMs": [round(float(b) * 1000, 1) for b in beats],
                "downbeatsMs": [round(float(b) * 1000, 1) for b in downs], "seconds": round(time.time() - start, 2)}
    except Exception as e:  # a file a decoder can't read
        return {"id": t["id"], "error": str(e)[:200]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("truth")
    ap.add_argument("outdir")
    ap.add_argument("--trackers", default="beat_this,essentia,librosa")
    ap.add_argument("--jobs", type=int, default=6)
    a = ap.parse_args()
    truth = [json.loads(l) for l in open(a.truth)]
    os.makedirs(a.outdir, exist_ok=True)
    for name in a.trackers.split(","):
        out = os.path.join(a.outdir, f"{name}.jsonl")
        done = set()
        if os.path.exists(out):
            done = {json.loads(l)["id"] for l in open(out)}
        todo = [(name, t) for t in truth if t["id"] not in done]
        start = time.time()
        with open(out, "a") as f, ProcessPoolExecutor(a.jobs) as pool:
            for i, r in enumerate(pool.map(work, todo, chunksize=4), 1):
                f.write(json.dumps(r) + "\n")
                f.flush()
                if i % 25 == 0:
                    print(f"{name}: {i}/{len(todo)}", file=sys.stderr, flush=True)
        print(f"{name}: {len(todo)} tracks in {time.time() - start:.0f}s", file=sys.stderr)


if __name__ == "__main__":
    main()
