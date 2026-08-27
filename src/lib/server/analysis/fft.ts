/**
 * Minimal in-place radix-2 complex FFT.
 *
 * Here rather than as a dependency because it is sixty lines, it is called from
 * exactly one place, and an audio-DSP package would drag a great deal more than
 * this into a project that decodes audio through one ffmpeg pipe.
 */

/** Bit-reversal permutation table for a given power-of-two size. */
function reversalTable(n: number): Uint32Array {
  const table = new Uint32Array(n);
  let bits = 0;
  while (1 << bits < n) bits++;
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    table[i] = r;
  }
  return table;
}

/**
 * Precomputed twiddles and permutation for one transform size. Reused across
 * every frame of a track — rebuilding them per frame dominated the runtime.
 */
export class Fft {
  readonly size: number;
  private readonly rev: Uint32Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${size}`);
    }
    this.size = size;
    this.rev = reversalTable(size);
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size);
    }
  }

  /** Transform in place. `re`/`im` must both be `size` long. */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const tw = k * step;
          const wr = this.cos[tw];
          const wi = this.sin[tw];
          const a = i + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}
