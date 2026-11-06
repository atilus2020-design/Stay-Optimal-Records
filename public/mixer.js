// Multitrack mixer: up to 5 layers (lead, harmonies, ad-libs…). Recording a new layer plays the
// existing ones back so the user can sing along; the final mix is rendered offline to mono PCM.
import { startRecording, createTranscriber, decodeBlob, MAX_RECORD_SECONDS, MAX_FILE_SECONDS } from "./recorder.js";

export const MAX_TRACKS = 5;
const DEFAULT_NAMES = ["Lead vocal", "Harmony", "Ad-libs", "Backing vocals", "Extra layer"];
const RATE = 44100;
const MIN_LAYER_SECONDS = 0.5;

let nextId = 1;

export class Mixer {
  constructor({ list, tpl, meterCanvas, onChange, onTime, onLyric, onInterim, onError }) {
    Object.assign(this, { list, tpl, meterCanvas, onChange, onTime, onLyric, onInterim, onError });
    this.tracks = [];
    this.ctx = null;
    this.play = null; // { sources: Map<id, {src, gain}>, startedAt, raf, timer }
    this.rec = null; // { session, track, isNew, transcriber, timer }
  }

  // ---------- state helpers ----------
  get isRecording() { return !!this.rec; }
  get isPlaying() { return !!this.play; }
  get full() { return this.tracks.length >= MAX_TRACKS; }

  audio() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  audible(t) {
    const anySolo = this.tracks.some((x) => x.solo && x.buffer);
    return !!t.buffer && !t.muted && (!anySolo || t.solo);
  }

  totalDuration() {
    return this.tracks.reduce((m, t) => (t.buffer ? Math.max(m, Math.max(0, t.offset) + t.buffer.duration) : m), 0);
  }

  // Changes whenever anything that affects the rendered mix changes (used to cache uploads).
  signature() {
    return JSON.stringify(
      this.tracks.filter((t) => t.buffer).map((t) => [t.id, t.version, t.volume, t.muted, t.solo, t.offset])
    );
  }

  newTrack() {
    const used = new Set(this.tracks.map((t) => t.name));
    const name = DEFAULT_NAMES.find((n) => !used.has(n)) || `Layer ${this.tracks.length + 1}`;
    return {
      id: nextId++, version: 0, name, buffer: null, peaks: null,
      volume: 1, muted: false, solo: false, offset: 0,
      words: this.tracks.length === 0, // only the first layer feeds lyrics by default
    };
  }

  // ---------- adding layers ----------
  async addFile(file) {
    if (this.full) throw new Error(`The mixer holds ${MAX_TRACKS} layers. Delete one to add another.`);
    const buffer = await decodeBlob(this.audio(), file);
    if (buffer.duration > MAX_FILE_SECONDS) throw new Error("That file is longer than 8 minutes.");
    const t = this.newTrack();
    t.name = file.name.replace(/\.[^.]+$/, "").slice(0, 30) || t.name;
    t.words = false;
    this.setBuffer(t, buffer);
    this.tracks.push(t);
    this.changed();
  }

  setBuffer(t, buffer) {
    t.buffer = buffer;
    t.version++;
    t.peaks = computePeaks(buffer, 300);
  }

  // ---------- recording ----------
  // Records into an existing layer (re-record) or a brand new one, playing the other layers back.
  async record(trackId) {
    if (this.rec) return;
    let track = this.tracks.find((t) => t.id === trackId);
    const isNew = !track;
    if (isNew) {
      if (this.full) throw new Error(`The mixer holds ${MAX_TRACKS} layers. Delete or re-record one.`);
      track = this.newTrack();
    }
    this.stop();
    const ctx = this.audio();
    const session = await startRecording({ canvas: this.meterCanvas, onTick: (s) => this.onTime(s) });
    // Start the backing playback the moment the mic is live, so the new take lines up with it.
    this.start({ exclude: track.id });
    let transcriber = null;
    if (track.words) {
      transcriber = createTranscriber({ onFinal: this.onLyric, onInterim: this.onInterim });
      if (transcriber) transcriber.start();
    }
    if (isNew) this.tracks.push(track);
    track.recording = true;
    this.rec = { session, track, isNew, transcriber, timer: setTimeout(() => this.stopRecording(), MAX_RECORD_SECONDS * 1000) };
    // Output + processing latency: the take arrives this late relative to what the singer heard.
    this.latency = Math.min(0.3, (ctx.outputLatency || 0) + (ctx.baseLatency || 0));
    this.changed();
  }

  async stopRecording() {
    const r = this.rec;
    if (!r) return null;
    this.rec = null;
    clearTimeout(r.timer);
    if (r.transcriber) r.transcriber.stop();
    this.stop();
    const { blob, seconds } = await r.session.stop();
    r.track.recording = false;
    let kept = false;
    if (seconds >= MIN_LAYER_SECONDS) {
      try {
        const buffer = await decodeBlob(this.audio(), blob);
        this.setBuffer(r.track, buffer);
        const hasBacking = this.tracks.some((t) => t !== r.track && t.buffer);
        r.track.offset = hasBacking ? -Math.round(this.latency * 100) / 100 : 0;
        kept = true;
      } catch (err) {
        this.onError(err.message);
      }
    }
    if (!kept && r.isNew) this.tracks = this.tracks.filter((t) => t !== r.track);
    this.changed();
    return kept ? r.track : null;
  }

  // ---------- playback ----------
  start({ exclude } = {}) {
    this.stop();
    const ctx = this.audio();
    const sources = new Map();
    const at = ctx.currentTime + 0.05;
    for (const t of this.tracks) {
      if (t.id === exclude || !this.audible(t)) continue;
      const src = ctx.createBufferSource();
      src.buffer = t.buffer;
      const gain = ctx.createGain();
      gain.gain.value = t.volume;
      src.connect(gain).connect(ctx.destination);
      // Negative offset = trim the start of the take; positive = delay it.
      src.start(at + Math.max(0, t.offset), Math.max(0, -t.offset));
      sources.set(t.id, { src, gain });
    }
    const total = this.totalDuration();
    const tick = () => {
      const pos = ctx.currentTime - at;
      this.list.querySelectorAll(".playhead").forEach((el) => {
        el.style.left = total ? `${Math.min(100, Math.max(0, (pos / total) * 100))}%` : "0";
        el.hidden = false;
      });
      if (!this.rec && pos > total + 0.1) return this.stop();
      this.play.raf = requestAnimationFrame(tick);
    };
    this.play = { sources, at, raf: requestAnimationFrame(tick) };
    this.onChange();
  }

  stop() {
    if (!this.play) return;
    cancelAnimationFrame(this.play.raf);
    for (const { src } of this.play.sources.values()) {
      try { src.stop(); } catch {}
    }
    this.play = null;
    this.list.querySelectorAll(".playhead").forEach((el) => (el.hidden = true));
    this.onChange();
  }

  // Live-update gains while playing (volume / mute / solo).
  refreshGains() {
    if (!this.play) return;
    for (const t of this.tracks) {
      const node = this.play.sources.get(t.id);
      if (node) node.gain.gain.value = this.audible(t) ? t.volume : 0;
    }
  }

  // ---------- mixdown ----------
  async mixdown() {
    const layers = this.tracks.filter((t) => this.audible(t));
    if (!layers.length) throw new Error("All layers are muted — unmute at least one.");
    const total = layers.reduce((m, t) => Math.max(m, Math.max(0, t.offset) + t.buffer.duration + Math.min(0, t.offset)), 0);
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(total * RATE)), RATE);
    for (const t of layers) {
      const src = off.createBufferSource();
      src.buffer = t.buffer;
      const g = off.createGain();
      g.gain.value = t.volume;
      src.connect(g).connect(off.destination);
      src.start(Math.max(0, t.offset), Math.max(0, -t.offset));
    }
    const rendered = await off.startRendering();
    return { pcm: rendered.getChannelData(0), rate: RATE, layers: layers.length };
  }

  // ---------- UI ----------
  changed() {
    this.render();
    this.onChange();
  }

  remove(id) {
    if (this.rec && this.rec.track.id === id) return;
    this.stop();
    this.tracks = this.tracks.filter((t) => t.id !== id);
    this.changed();
  }

  render() {
    this.list.replaceChildren();
    const total = this.totalDuration();
    const supportsWords = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    for (const t of this.tracks) {
      const row = this.tpl.content.firstElementChild.cloneNode(true);
      const q = (s) => row.querySelector(s);
      row.classList.toggle("is-recording", !!t.recording);
      row.classList.toggle("is-muted", !this.audible(t) && !!t.buffer);

      const name = q(".layer-name");
      name.value = t.name;
      name.addEventListener("input", () => (t.name = name.value.slice(0, 30)));

      const recBtn = q(".layer-rec");
      recBtn.classList.toggle("live", !!t.recording);
      recBtn.title = t.recording ? "Stop recording" : t.buffer ? "Re-record this layer" : "Record";
      recBtn.disabled = !!this.rec && !t.recording;
      recBtn.addEventListener("click", () =>
        t.recording ? this.stopRecording() : this.record(t.id).catch((e) => this.onError(e.message))
      );

      const toggle = (sel, key) => {
        const b = q(sel);
        b.classList.toggle("on", !!t[key]);
        b.setAttribute("aria-pressed", String(!!t[key]));
        b.addEventListener("click", () => {
          t[key] = !t[key];
          if (key === "words") return this.render();
          this.refreshGains();
          this.render();
        });
      };
      toggle(".mute", "muted");
      toggle(".solo", "solo");
      toggle(".words", "words");
      q(".words").hidden = !supportsWords;
      q(".del").addEventListener("click", () => this.remove(t.id));
      q(".del").disabled = !!t.recording;

      const vol = q(".vol");
      vol.value = t.volume;
      vol.addEventListener("input", () => {
        t.volume = Number(vol.value);
        this.refreshGains();
      });
      const nudge = q(".nudge");
      const out = q(".nudge-out");
      nudge.value = Math.round(t.offset * 1000);
      out.textContent = fmtMs(t.offset);
      nudge.addEventListener("input", () => {
        t.offset = Number(nudge.value) / 1000;
        out.textContent = fmtMs(t.offset);
      });
      nudge.addEventListener("change", () => this.render());

      const canvas = q("canvas");
      if (t.recording) q(".layer-wave").classList.add("pending");
      else drawWave(canvas, t, total);
      const dur = q(".layer-dur");
      dur.textContent = t.recording ? "Recording…" : t.buffer ? fmtClock(t.buffer.duration) : "";
      this.list.append(row);
    }
  }
}

// ---------- drawing ----------
function computePeaks(buffer, n) {
  const ch = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(ch.length / n));
  const peaks = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    const end = Math.min(ch.length, (i + 1) * step);
    for (let j = i * step; j < end; j += 4) m = Math.max(m, Math.abs(ch[j]));
    peaks[i] = m;
  }
  let max = 0;
  for (const p of peaks) max = Math.max(max, p);
  if (max > 0) for (let i = 0; i < n; i++) peaks[i] /= max;
  return peaks;
}

function drawWave(canvas, t, total) {
  const g = canvas.getContext("2d");
  const { width, height } = canvas;
  g.clearRect(0, 0, width, height);
  if (!t.buffer || !total) return;
  const css = getComputedStyle(document.documentElement);
  g.fillStyle = (t.muted ? css.getPropertyValue("--muted") : css.getPropertyValue("--accent")).trim() || "#b6ff3b";
  const start = (Math.max(0, t.offset) / total) * width;
  const visible = t.buffer.duration + Math.min(0, t.offset);
  const span = (visible / total) * width;
  const skip = Math.max(0, -t.offset) / t.buffer.duration; // fraction trimmed from the start
  const n = t.peaks.length;
  const barW = 2;
  for (let x = 0; x < span; x += barW + 1) {
    const frac = skip + (x / span) * (1 - skip);
    const p = t.peaks[Math.min(n - 1, Math.floor(frac * n))];
    const h = Math.max(1, p * (height - 4));
    g.fillRect(start + x, (height - h) / 2, barW, h);
  }
}

const fmtClock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const fmtMs = (s) => `${s > 0 ? "+" : ""}${Math.round(s * 1000)} ms`;
