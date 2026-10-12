// Pure audio helpers: mixdown, resampling and chunk planning.
// No DOM dependencies, so they run in the browser, the worker, Node and vitest.

export const TARGET_SAMPLE_RATE = 16000;

/**
 * Average any number of channels into one mono Float32Array.
 * @param {Float32Array[]} channels
 * @returns {Float32Array}
 */
export function mixToMono(channels) {
  if (!channels || channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return Float32Array.from(channels[0]);
  const len = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(len);
  const n = channels.length;
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let c = 0; c < n; c++) s += channels[c][i];
    out[i] = s / n;
  }
  return out;
}

/**
 * Resample with linear interpolation. When downsampling, a simple box
 * low-pass (averaging over the source span) is applied first to limit aliasing.
 * @param {Float32Array} input
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Float32Array}
 */
export function resampleLinear(input, fromRate, toRate = TARGET_SAMPLE_RATE) {
  if (!(fromRate > 0) || !(toRate > 0)) throw new Error('Sample rates must be positive');
  if (fromRate === toRate) return Float32Array.from(input);
  const ratio = fromRate / toRate;
  const outLen = Math.max(0, Math.round(input.length / ratio));
  const out = new Float32Array(outLen);
  if (input.length === 0) return out;
  if (ratio > 1) {
    // Downsample: average all source samples that fall into each output bin.
    for (let i = 0; i < outLen; i++) {
      const start = i * ratio;
      const end = Math.min(input.length, start + ratio);
      let a = Math.floor(start);
      const b = Math.max(a + 1, Math.ceil(end));
      let sum = 0;
      let count = 0;
      for (; a < b && a < input.length; a++) {
        sum += input[a];
        count++;
      }
      out[i] = count ? sum / count : 0;
    }
  } else {
    // Upsample: linear interpolation.
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, input.length - 1);
      const t = pos - i0;
      out[i] = input[i0] * (1 - t) + input[i1] * t;
    }
  }
  return out;
}

/**
 * Plan Whisper-style sliding windows (default 30 s windows with a 5 s stride
 * on each side), mirroring how the ASR pipeline chunks long audio.
 * Returns windows in samples. Useful for progress estimation.
 */
export function planWindows(totalSamples, sampleRate = TARGET_SAMPLE_RATE, chunkS = 30, strideS = 5) {
  const window = Math.round(chunkS * sampleRate);
  const stride = Math.round(strideS * sampleRate);
  const step = window - 2 * stride;
  if (step <= 0) throw new Error('stride too large for chunk length');
  const out = [];
  if (totalSamples <= 0) return out;
  for (let offset = 0; ; offset += step) {
    const start = offset;
    const end = Math.min(totalSamples, offset + window);
    out.push({ start, end });
    if (end >= totalSamples) break;
  }
  return out;
}

/** Index of the quietest `winSamples` window inside [from, to). */
export function findQuietPoint(samples, from, to, winSamples) {
  from = Math.max(0, Math.floor(from));
  to = Math.min(samples.length, Math.floor(to));
  if (to - from <= winSamples) return Math.floor((from + to) / 2);
  let energy = 0;
  for (let i = from; i < from + winSamples; i++) energy += samples[i] * samples[i];
  let best = energy;
  let bestIdx = from;
  for (let i = from + winSamples; i < to; i++) {
    energy += samples[i] * samples[i] - samples[i - winSamples] * samples[i - winSamples];
    if (energy < best - 1e-12) {
      best = energy;
      bestIdx = i - winSamples + 1;
    }
  }
  return bestIdx + Math.floor(winSamples / 2);
}

/**
 * Split long audio into outer segments (default ~2 minutes) that are each fed
 * to the chunked Whisper pipeline. When `samples` are supplied, each cut is
 * moved to the quietest 100 ms within +/- searchS of the nominal boundary so
 * words are not cut in half. Segments are contiguous and cover all samples.
 */
export function planSegments(totalSamples, { sampleRate = TARGET_SAMPLE_RATE, segmentS = 120, searchS = 4, samples = null } = {}) {
  const seg = Math.round(segmentS * sampleRate);
  const search = Math.round(searchS * sampleRate);
  const out = [];
  if (totalSamples <= 0) return out;
  let start = 0;
  while (start < totalSamples) {
    let end = start + seg;
    if (end + search >= totalSamples) {
      out.push({ start, end: totalSamples });
      break;
    }
    if (samples) {
      end = findQuietPoint(samples, end - search, end + search, Math.round(0.1 * sampleRate));
    }
    out.push({ start, end });
    start = end;
  }
  return out;
}

/** RMS level of a buffer in [0..1] - used by the live level meter. */
export function rms(buf) {
  if (!buf.length) return 0;
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}
