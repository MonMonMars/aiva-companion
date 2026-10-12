/** Convert float32 mono samples (-1..1) to base64-encoded PCM16 LE. */
export function float32ToBase64Pcm16(samples) {
  const pcm16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(pcm16.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  if (typeof btoa === 'function') return btoa(binary);
  return Buffer.from(bytes).toString('base64');
}

/** Decode base64 PCM16 LE to float32 mono samples. */
export function base64Pcm16ToFloat32(base64) {
  let bytes;
  if (typeof atob === 'function') {
    const binary = atob(base64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
  } else {
    bytes = new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const pcm16 = new Int16Array(bytes.buffer);
  const out = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    out[i] = (pcm16[i] ?? 0) / 32768;
  }
  return out;
}

/** Linear resample mono float32 (simple; fine for realtime mic bridging). */
export function resampleFloat32(input, fromRate, toRate) {
  if (fromRate === toRate || input.length === 0) {
    return input;
  }
  const ratio = toRate / fromRate;
  const outLength = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i / ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const a = input[idx] ?? 0;
    const b = input[idx + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}
