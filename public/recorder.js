// Browser-side recording helpers: mic capture with a live level meter,
// optional speech-to-text (Web Speech API), and MP3 compression (lamejs) so
// uploads stay well under Netlify's ~6 MB function payload limit.

export const MIN_SECONDS = 6; // SunoAPI minimum for reference audio
export const MAX_RECORD_SECONDS = 180;
export const MAX_FILE_SECONDS = 480; // upload-cover limit: 8 minutes
const TARGET_BYTES = 4_000_000;
const BITRATES = [128, 112, 96, 80, 64, 56, 48, 40, 32];

export const canRecord = () =>
  !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);

export async function startRecording({ canvas, onTick }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const mime =
    ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find(
      (t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)
    ) || "";
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);

  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const levels = [];
  const g = canvas.getContext("2d");
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--danger").trim() || "#ff5c7a";
  let raf = 0;
  const t0 = performance.now();

  const draw = () => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += s * s;
    levels.push(Math.min(1, Math.sqrt(sum / samples.length) * 4));
    const { width, height } = canvas;
    const barW = 6;
    const maxBars = Math.floor(width / barW);
    while (levels.length > maxBars) levels.shift();
    g.clearRect(0, 0, width, height);
    g.fillStyle = accent;
    levels.forEach((lv, i) => {
      const h = Math.max(2, lv * height);
      g.fillRect(i * barW, (height - h) / 2, barW - 2, h);
    });
    onTick && onTick((performance.now() - t0) / 1000);
    raf = requestAnimationFrame(draw);
  };
  rec.start(250);
  draw();

  const cleanup = () => {
    cancelAnimationFrame(raf);
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
  };

  return {
    stop: () =>
      new Promise((resolve) => {
        rec.onstop = () => {
          cleanup();
          resolve({
            blob: new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" }),
            seconds: (performance.now() - t0) / 1000,
          });
        };
        rec.stop();
      }),
  };
}

// Live transcription so what the user sings or says can become lyrics. Chrome/Edge/Safari only.
export function createTranscriber({ onFinal, onInterim }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.continuous = true;
  r.interimResults = true;
  r.lang = navigator.language || "en-US";
  let active = false;
  r.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const text = e.results[i][0].transcript.trim();
      if (!text) continue;
      if (e.results[i].isFinal) onFinal(text);
      else interim += text + " ";
    }
    onInterim(interim.trim());
  };
  // Recognition ends on its own after silence; restart while we're still recording.
  r.onend = () => {
    if (active) {
      try { r.start(); } catch {}
    }
  };
  r.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") active = false;
  };
  return {
    start() { active = true; try { r.start(); } catch {} },
    stop() { active = false; try { r.stop(); } catch {} },
  };
}

// Decode any browser-playable audio (a recording or an uploaded file) into an AudioBuffer.
export async function decodeBlob(ctx, blob) {
  try {
    return await ctx.decodeAudioData(await blob.arrayBuffer());
  } catch {
    throw new Error("Couldn't read that audio. Try another recording or file format.");
  }
}

// Encode mono PCM (44.1 kHz Float32Array) to an MP3 data URL, normalising level and
// picking a bitrate that keeps the upload under Netlify's request limit.
export async function encodePcmMp3(pcm, rate, onProgress) {
  if (!window.lamejs) throw new Error("Audio encoder failed to load. Refresh the page and try again.");
  const duration = pcm.length / rate;
  if (duration < MIN_SECONDS) throw new Error(`Your mix is too short — at least ${MIN_SECONDS} seconds please.`);
  if (duration > MAX_FILE_SECONDS) throw new Error("Your mix is longer than 8 minutes. Trim a layer and try again.");

  // Boost quiet takes, and pull stacked layers back so they don't clip.
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  const gain = peak === 0 ? 1 : peak > 0.95 ? 0.95 / peak : peak < 0.8 ? Math.min(4, 0.9 / peak) : 1;

  const maxKbps = (TARGET_BYTES * 8) / 1000 / duration;
  const kbps = BITRATES.find((b) => b <= maxKbps) || 32;
  const enc = new window.lamejs.Mp3Encoder(1, rate, kbps);
  const block = 1152;
  const out = [];
  const i16 = new Int16Array(block);
  for (let i = 0, n = 0; i < pcm.length; i += block, n++) {
    const len = Math.min(block, pcm.length - i);
    const chunk = len === block ? i16 : new Int16Array(len);
    for (let j = 0; j < len; j++) {
      const s = Math.max(-1, Math.min(1, pcm[i + j] * gain));
      chunk[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const buf = enc.encodeBuffer(chunk);
    if (buf.length) out.push(new Uint8Array(buf));
    if (n % 300 === 0) {
      onProgress && onProgress(i / pcm.length);
      await new Promise((r) => setTimeout(r)); // keep the UI responsive
    }
  }
  const tail = enc.flush();
  if (tail.length) out.push(new Uint8Array(tail));
  const mp3 = new Blob(out, { type: "audio/mpeg" });
  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("Couldn't prepare the recording."));
    fr.readAsDataURL(mp3);
  });
  return { dataUrl, duration, bytes: mp3.size, kbps };
}
