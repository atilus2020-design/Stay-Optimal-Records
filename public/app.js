// Stay Optimal Records — AI Music Studio (frontend)
// Talks only to our own Netlify Functions under /api/*; the SunoAPI key never reaches the browser.

import { canRecord, encodePcmMp3 } from "./recorder.js";
import { Mixer, MAX_TRACKS } from "./mixer.js";
import { parseClock, detectLength, extractCues, MAX_DURATION, fmtClock as clockOf } from "./notes.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const STORE_KEY = "som.jobs.v1";
const PASS_KEY = "som.passcode";
const POLL_MS = 8000;
const MAX_POLL_MS = 15 * 60 * 1000;

const FAIL_STATUSES = new Set([
  "CREATE_TASK_FAILED",
  "GENERATE_AUDIO_FAILED",
  "CALLBACK_EXCEPTION",
  "SENSITIVE_WORD_ERROR",
]);
const STATUS_LABEL = {
  PENDING: "Queued",
  TEXT_SUCCESS: "Writing",
  FIRST_SUCCESS: "Rendering",
  SUCCESS: "Ready",
  CREATE_TASK_FAILED: "Failed",
  GENERATE_AUDIO_FAILED: "Failed",
  CALLBACK_EXCEPTION: "Failed",
  SENSITIVE_WORD_ERROR: "Blocked",
};
const CODE_MSG = {
  400: "Some inputs were invalid. Try adjusting your prompt.",
  401: "The server's SunoAPI key was rejected. Check SUNO_API_KEY in Netlify.",
  405: "Rate limit hit. Wait a moment and try again.",
  413: "Your prompt or lyrics are too long.",
  429: "Out of credits. Top up your SunoAPI.org account.",
  430: "Too many requests. Slow down and try again shortly.",
  455: "SunoAPI is under maintenance. Try again later.",
  500: "SunoAPI server error. Try again.",
};

const IDEAS = [
  "Lo-fi hip hop beat for late-night studying, vinyl crackle, mellow piano",
  "Uplifting Afrobeats anthem about summer love, catchy hook",
  "Dark cinematic trap with haunting choir and heavy 808s",
  "Feel-good 80s synthwave road trip song with male vocals",
  "Acoustic folk ballad about leaving your hometown, soft female vocals",
  "High-energy EDM festival drop with euphoric build",
];
const STYLES = ["trap", "R&B", "lo-fi", "drill", "afrobeats", "pop", "house", "neo-soul", "rock", "cinematic", "jazz", "reggaeton"];

const USE_LABEL = {
  cover: "Remix of my voice",
  "add-instrumental": "My vocals + beat",
  reference: "Inspired by my recording",
};

let jobs = load();
const timers = new Map();
let mode = "simple";

// ---------- storage ----------
function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || [];
  } catch {
    return [];
  }
}
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(jobs.slice(0, 60)));
  } catch {}
}
const getPass = () => {
  try { return localStorage.getItem(PASS_KEY) || ""; } catch { return ""; }
};
const setPass = (v) => {
  try { localStorage.setItem(PASS_KEY, v); } catch {}
};

// ---------- API ----------
class ApiError extends Error {}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(getPass() ? { "x-app-passcode": getPass() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new ApiError(`Server error (HTTP ${res.status}).`);
  }
  if (res.status === 401 && /passcode/i.test(data.msg || "")) {
    $("#lockBtn").hidden = false;
    const ok = await askPasscode();
    if (ok) return api(path, { method, body });
    throw new ApiError("Passcode required.");
  }
  if (data.code !== 200) {
    throw new ApiError(data.msg && data.msg !== "success" ? `${data.msg}` : CODE_MSG[data.code] || "Request failed.");
  }
  return data.data;
}

function askPasscode() {
  const dlg = $("#passDialog");
  $("#passInput").value = getPass();
  return new Promise((resolve) => {
    dlg.addEventListener(
      "close",
      () => {
        if (dlg.returnValue === "ok") {
          setPass($("#passInput").value.trim());
          resolve(true);
        } else resolve(false);
      },
      { once: true }
    );
    dlg.showModal();
  });
}

async function refreshCredits() {
  try {
    const n = await api("/api/credits");
    $("#credits").textContent = `Credits: ${Number(n).toLocaleString()}`;
  } catch {
    $("#credits").textContent = "Credits: —";
  }
}

// ---------- form ----------
function setMode(m) {
  mode = m;
  $$(".tab").forEach((t) => {
    const on = t.dataset.mode === m;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on);
  });
  $(".mode-simple").hidden = m !== "simple";
  $(".mode-custom").hidden = m !== "custom";
  $(".mode-record").hidden = m !== "record";
  $("#instrumentalWrap").hidden = m === "record";
  $("#genBtn .btn-label").textContent = genLabel();
  syncInstrumental();
  syncNotes();
}

// ---------- producer notes ----------
// Where the target length is applied exactly via SunoAPI's `duration` parameter.
const exactLength = () => mode === "custom" || (mode === "record" && recUse() === "cover");

function targetSeconds() {
  const raw = $("#targetLen").value.trim();
  if (!raw) return undefined;
  const s = parseClock(raw);
  if (!Number.isFinite(s) || s < 10) throw new Error("Target length should look like 3:00 (at least 0:10).");
  return Math.min(MAX_DURATION, s);
}

function notesPayload() {
  return { notes: $("#notes").value.trim(), targetSeconds: targetSeconds() };
}

function syncNotes() {
  const text = $("#notes").value;
  $("#notesCount").textContent = text.length;

  // Auto-fill the target length from phrases like "make it 3 minutes", unless the user typed one.
  const lenInput = $("#targetLen");
  const found = detectLength(text);
  if (lenInput.dataset.auto === "1" || !lenInput.value.trim()) {
    if (found) {
      lenInput.value = clockOf(Math.min(found, MAX_DURATION));
      lenInput.dataset.auto = "1";
    } else if (lenInput.dataset.auto === "1") {
      lenInput.value = "";
      lenInput.dataset.auto = "";
    }
  }

  const help = $("#lenHelp");
  const raw = lenInput.value.trim();
  const secs = raw ? parseClock(raw) : NaN;
  if (raw && (!Number.isFinite(secs) || secs < 10)) help.textContent = "Use m:ss, e.g. 3:00.";
  else if (found && found > MAX_DURATION)
    help.textContent = `Max ${clockOf(MAX_DURATION)} per generation. Generate at 6:00, then use ⏩ Extend on the finished track to go longer.`;
  else if (raw && lenInput.dataset.auto === "1") help.textContent = `Picked up ${raw} from your notes.`;
  else help.textContent = "";
  help.classList.toggle("warn", !!help.textContent && !help.textContent.startsWith("Picked"));

  const cues = extractCues(text);
  const list = $("#notesCues");
  list.replaceChildren(
    ...cues.map((c) => {
      const li = document.createElement("li");
      const b = document.createElement("b");
      b.textContent = c.endSecs ? `${clockOf(c.secs)}–${clockOf(c.endSecs)}` : clockOf(c.secs);
      li.append(b, document.createTextNode(c.text));
      return li;
    })
  );
  list.hidden = !cues.length;

  const how = exactLength()
    ? "Length is applied exactly (up to 6:00)."
    : "In this mode the length is passed to the AI as a request, so the result can run a bit shorter or longer.";
  $("#notesHint").textContent =
    `${how} Notes and timestamps steer the arrangement. The AI follows them closely, but not to the exact second. ` +
    "To change what happens at an exact moment of a finished song, use ⏩ Extend on the track.";
}

function syncInstrumental() {
  const inst = $("#instrumental").checked;
  $("#lyrics").disabled = inst;
  $("#writeLyricsBtn").disabled = inst;
  $("#lyrics").placeholder = inst ? "Instrumental — no lyrics needed." : "[Verse]\nStreetlights hum a low refrain...\n\n[Chorus]\n...";
}

const genLabel = () => (mode === "record" ? "Turn it into a song" : "Generate track");
const recUse = () => $('input[name="recUse"]:checked').value;

function collectForm() {
  const v = (id) => $("#" + id).value.trim();
  const base = {
    customMode: mode === "custom",
    instrumental: $("#instrumental").checked,
    model: v("model"),
    ...notesPayload(),
  };
  if (mode === "simple") return { ...base, prompt: v("prompt") };
  const body = {
    ...base,
    title: v("title"),
    style: v("style"),
    lyrics: v("lyrics"),
    negativeTags: v("negativeTags"),
    vocalGender: v("vocalGender"),
  };
  for (const id of ["styleWeight", "weirdnessConstraint", "variety"]) {
    const el = $("#" + id);
    if (el.dataset.touched === "1") body[id] = Number(el.value);
  }
  return body;
}

function setMsg(text, isError = false) {
  const m = $("#formMsg");
  m.textContent = text;
  m.classList.toggle("error", isError);
}

async function onGenerate(e) {
  e.preventDefault();
  if (mode === "record") return onGenerateFromRecording();
  let body;
  try {
    body = collectForm();
  } catch (err) {
    return setMsg(err.message, true);
  }
  if (mode === "simple" && !body.prompt) return setMsg("Describe the song you want first.", true);
  if (mode === "custom" && !body.style && !body.lyrics && !body.negativeTags && !body.notes)
    return setMsg("Add a style, some lyrics, or producer notes first.", true);

  const btn = $("#genBtn");
  btn.disabled = true;
  btn.querySelector(".btn-label").textContent = "Sending to the studio…";
  setMsg("");
  try {
    const data = await api("/api/generate", { method: "POST", body });
    addJob({
      taskId: data.taskId,
      model: body.model,
      title: body.title || (body.prompt ? body.prompt.slice(0, 60) : (body.style || body.notes).slice(0, 60)) || "Untitled",
      sub: [
        body.model,
        body.instrumental ? "Instrumental" : null,
        body.targetSeconds ? `~${clockOf(body.targetSeconds)}` : null,
        body.customMode ? body.style : body.prompt,
        body.notes ? `📝 ${body.notes}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
    setMsg("Generating — first take usually streams in under a minute.");
  } catch (err) {
    setMsg(err.message, true);
  } finally {
    btn.disabled = false;
    btn.querySelector(".btn-label").textContent = genLabel();
  }
}

function addJob(job) {
  jobs.unshift({ createdAt: Date.now(), status: "PENDING", tracks: [], error: "", ...job });
  save();
  render();
  poll(job.taskId);
}

// ---------- recording / mixer ----------
let mixer = null;
let uploadCache = { sig: "", url: "" }; // reuse the uploaded mix if nothing changed

const fmtClock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const REC_HINT = "Tap to record a layer. Stack up to 5: lead, harmonies, ad-libs, hums, spoken ideas.";

function appendLyricLine(text) {
  const el = $("#recLyrics");
  const line = text.charAt(0).toUpperCase() + text.slice(1);
  el.value = el.value.trim() ? `${el.value.trimEnd()}\n${line}` : line;
  el.scrollTop = el.scrollHeight;
}

function syncMixerUi() {
  const n = mixer.tracks.length;
  const recording = mixer.isRecording;
  $("#trackCount").textContent = `${n} / ${MAX_TRACKS} layers`;
  $("#mixEmpty").hidden = n > 0;
  $("#recorder").classList.toggle("live", recording);
  const big = $("#recBtn");
  big.disabled = !recording && mixer.full;
  big.setAttribute("aria-label", recording ? "Stop recording" : "Record a new layer");
  const play = $("#mixPlay");
  play.disabled = recording || !mixer.tracks.some((t) => t.buffer);
  play.textContent = mixer.isPlaying && !recording ? "■ Stop" : "▶ Play mix";
  $("#addFileBtn").classList.toggle("disabled", mixer.full || recording);
  if (recording) {
    const others = mixer.tracks.filter((t) => t.buffer && !t.recording && mixer.audible(t)).length;
    if (!$("#recHint").textContent.startsWith("“"))
      $("#recHint").textContent = others
        ? `Recording “${mixer.rec.track.name}” over ${others} layer${others > 1 ? "s" : ""}… tap the red button to stop.`
        : `Recording “${mixer.rec.track.name}”… tap the red button to stop.`;
  } else {
    $("#recHint").textContent = mixer.full
      ? "Mixer is full (5 layers). Re-record or delete a layer to change it."
      : n
      ? `Layer ${n} saved. Tap the red button to stack another — the mix plays back while you record.`
      : REC_HINT;
  }
}

async function onBigRecord() {
  setMsg("");
  if (mixer.isRecording) return void (await mixer.stopRecording());
  if (!canRecord()) return setMsg("Recording isn't supported in this browser. Add an audio file instead.", true);
  try {
    await mixer.record();
  } catch (err) {
    onRecordError(err);
  }
}

function onRecordError(err) {
  const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
  setMsg(
    denied
      ? "Microphone access was blocked. Allow it from your browser's address bar and try again."
      : err.message || "Couldn't start the microphone.",
    true
  );
}

async function onFilePicked(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (file.size > 60 * 1024 * 1024) return setMsg("That file is too big (60 MB max).", true);
  setMsg("Loading file…");
  try {
    await mixer.addFile(file);
    setMsg("");
    if (!$("#recTitle").value.trim()) $("#recTitle").value = file.name.replace(/\.[^.]+$/, "").slice(0, 80);
  } catch (err) {
    setMsg(err.message, true);
  }
}

async function onGenerateFromRecording() {
  if (mixer.isRecording) await mixer.stopRecording();
  mixer.stop();
  if (!mixer.tracks.some((t) => t.buffer)) return setMsg("Record at least one layer (or add a file) first.", true);
  let notes;
  try {
    notes = notesPayload();
  } catch (err) {
    return setMsg(err.message, true);
  }
  const action = recUse();
  const btn = $("#genBtn");
  const label = btn.querySelector(".btn-label");
  btn.disabled = true;
  setMsg("");
  try {
    const sig = mixer.signature();
    let layers = mixer.tracks.filter((t) => mixer.audible(t)).length;
    if (uploadCache.sig !== sig) {
      label.textContent = "Mixing your layers…";
      const mix = await mixer.mixdown();
      layers = mix.layers;
      const { dataUrl } = await encodePcmMp3(mix.pcm, mix.rate, (p) => {
        label.textContent = `Preparing your mix… ${Math.round(p * 100)}%`;
      });
      label.textContent = "Uploading…";
      const up = await api("/api/upload", {
        method: "POST",
        body: { base64Data: dataUrl, fileName: `mix-${Date.now()}.mp3` },
      });
      uploadCache = { sig, url: up.url };
    }
    label.textContent = "Sending to the studio…";
    const v = (id) => $("#" + id).value.trim();
    const body = {
      action,
      model: v("model"),
      uploadUrl: uploadCache.url,
      title: v("recTitle"),
      style: v("recStyle"),
      lyrics: v("recLyrics"),
      prompt: action === "reference" ? v("recPrompt") : "",
      audioWeight: action === "reference" ? undefined : Number($("#recAudioWeight").value),
      ...notes,
    };
    const data = await api("/api/generate", { method: "POST", body });
    addJob({
      taskId: data.taskId,
      model: body.model,
      title: body.title || "My recording",
      sub: [
        body.model,
        USE_LABEL[action],
        `${layers} layer${layers > 1 ? "s" : ""}`,
        body.targetSeconds ? `~${clockOf(body.targetSeconds)}` : null,
        body.style,
        body.notes ? `📝 ${body.notes}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
    setMsg("Your mix is in the studio — the first take usually lands in a minute or two.");
  } catch (err) {
    setMsg(err.message, true);
  } finally {
    btn.disabled = false;
    label.textContent = genLabel();
  }
}

// ---------- lyrics helper ----------
async function onWriteLyrics() {
  const seed = [$("#title").value.trim(), $("#style").value.trim()].filter(Boolean).join(" — ");
  const topic = window.prompt("What should the lyrics be about? (max 200 chars)", seed);
  if (!topic || !topic.trim()) return;
  const btn = $("#writeLyricsBtn");
  btn.disabled = true;
  btn.textContent = "✍️ Writing…";
  try {
    const { taskId } = await api("/api/lyrics", { method: "POST", body: { prompt: topic.trim().slice(0, 200) } });
    const started = Date.now();
    while (Date.now() - started < 3 * 60 * 1000) {
      await sleep(4000);
      const d = await api(`/api/lyrics?taskId=${encodeURIComponent(taskId)}`);
      const items = d?.response?.data || d?.response?.lyricsData || d?.data || [];
      const good = items.find((x) => x && x.text && x.status !== "failed");
      if (good) {
        $("#lyrics").value = good.text;
        if (!$("#title").value.trim() && good.title) $("#title").value = good.title;
        setMsg("Lyrics ready — tweak them, then generate.");
        return;
      }
      if (d?.status && /FAIL|ERROR/.test(d.status)) throw new ApiError(d.errorMessage || "Lyrics generation failed.");
    }
    throw new ApiError("Lyrics took too long. Try again.");
  } catch (err) {
    setMsg(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "✍️ Write lyrics with AI";
  }
}

// ---------- polling ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTerminal = (s) => s === "SUCCESS" || FAIL_STATUSES.has(s) || /FAIL|ERROR/.test(s || "");

function normalizeTrack(t) {
  return {
    id: t.id,
    title: t.title || "Untitled",
    tags: t.tags || "",
    duration: t.duration || 0,
    audio: t.audio_url || t.audioUrl || t.source_audio_url || t.sourceAudioUrl || "",
    stream: t.stream_audio_url || t.streamAudioUrl || t.source_stream_audio_url || t.sourceStreamAudioUrl || "",
    image: t.image_url || t.imageUrl || t.source_image_url || t.sourceImageUrl || "",
    lyrics: t.prompt || "",
  };
}

function poll(taskId) {
  if (timers.has(taskId)) return;
  const tick = async () => {
    const job = jobs.find((j) => j.taskId === taskId);
    if (!job) return timers.delete(taskId);
    try {
      const d = await api(`/api/status?taskId=${encodeURIComponent(taskId)}`);
      const raw = d?.response?.sunoData || d?.response?.data || [];
      if (raw.length) job.tracks = raw.map(normalizeTrack);
      job.status = d?.status || job.status;
      if (FAIL_STATUSES.has(job.status) || /FAIL|ERROR/.test(job.status)) {
        job.error = d?.errorMessage || (job.status === "SENSITIVE_WORD_ERROR" ? "Prompt contained blocked words." : "Generation failed.");
      }
    } catch (err) {
      // transient errors: keep polling
      console.warn("poll error", err);
    }
    if (!isTerminal(job.status) && Date.now() - job.createdAt > MAX_POLL_MS) {
      job.status = "TIMEOUT";
      job.error = "Timed out waiting for the track. Try again.";
    }
    save();
    render();
    if (isTerminal(job.status) || job.status === "TIMEOUT") {
      timers.delete(taskId);
      if (job.status === "SUCCESS") refreshCredits();
      return;
    }
    timers.set(taskId, setTimeout(tick, POLL_MS));
  };
  timers.set(taskId, setTimeout(tick, 2500));
}

// ---------- rendering ----------
const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");
let nowPlaying = null;

// Per-track UI state that must survive re-renders (polling re-renders the list every few seconds).
const extendDrafts = new Map(); // trackId -> { at, notes, lyrics }
const lyricsOpen = new Set();

function snapshotFocus() {
  const a = document.activeElement;
  if (!a || !a.closest || !a.closest("#jobs") || !a.dataset.focus) return null;
  const card = a.closest(".track-card");
  return { id: card && card.dataset.id, key: a.dataset.focus, start: a.selectionStart, end: a.selectionEnd };
}

function restoreFocus(f) {
  if (!f) return;
  const card = [...$$("#jobs .track-card")].find((c) => c.dataset.id === f.id);
  const el = card && card.querySelector(`[data-focus="${f.key}"]`);
  if (!el) return;
  el.focus();
  try { el.setSelectionRange(f.start, f.end); } catch {}
}

async function submitExtend(job, t) {
  const d = extendDrafts.get(t.id);
  const at = parseClock(d.at);
  d.error = "";
  if (!Number.isFinite(at) || at <= 0) d.error = "Enter where to start, like 1:30.";
  else if (t.duration && at >= t.duration) d.error = `Pick a time before the end of the track (${fmtDur(t.duration)}).`;
  if (d.error) return render();
  d.busy = true;
  render();
  try {
    const body = {
      action: "extend",
      model: job.model || "V6", // must match the source track's model
      audioId: t.id,
      taskId: job.taskId,
      continueAt: at,
      title: `${t.title} (Extended)`.slice(0, 100),
      style: t.tags,
      notes: d.notes.trim(),
      lyrics: d.lyrics.trim(),
    };
    const data = await api("/api/generate", { method: "POST", body });
    extendDrafts.delete(t.id);
    addJob({
      taskId: data.taskId,
      model: body.model,
      title: body.title,
      sub: [`Extended from ${clockOf(at)}`, body.notes ? `📝 ${body.notes}` : null].filter(Boolean).join(" · "),
    });
    $("#jobs").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    d.busy = false;
    d.error = err.message;
    render();
  }
}

function renderExtend(card, job, t) {
  const box = $(".extend-box", card);
  const btn = $(".ext", card);
  if (!t.audio || !t.id) {
    btn.hidden = true;
    return;
  }
  btn.addEventListener("click", () => {
    if (extendDrafts.has(t.id)) extendDrafts.delete(t.id);
    else extendDrafts.set(t.id, { at: clockOf(Math.max(1, Math.floor(t.duration || 0) - 1)), notes: "", lyrics: "" });
    render();
  });
  const d = extendDrafts.get(t.id);
  if (!d) return;
  btn.classList.add("on");
  box.hidden = false;
  const at = $(".ext-at", box);
  const notes = $(".ext-notes", box);
  const lyrics = $(".ext-lyrics", box);
  at.value = d.at;
  notes.value = d.notes;
  lyrics.value = d.lyrics;
  at.addEventListener("input", () => (d.at = at.value));
  notes.addEventListener("input", () => (d.notes = notes.value));
  lyrics.addEventListener("input", () => (d.lyrics = lyrics.value));
  $(".ext-help", box).textContent =
    `Track length ${fmtDur(t.duration)}. Everything before your start point stays, and the AI continues from there following your notes. ` +
    "Start near the end to make the song longer, or pick an earlier moment to change what happens there.";
  const nowBtn = $(".ext-now", box);
  nowBtn.disabled = nowPlaying !== t.id;
  nowBtn.title = nowPlaying === t.id ? "Use the current position of the player" : "Play this track first, pause at the moment you want";
  nowBtn.addEventListener("click", () => {
    d.at = clockOf(Math.max(1, Math.floor($("#audio").currentTime)));
    render();
  });
  $(".ext-end", box).addEventListener("click", () => {
    d.at = clockOf(Math.max(1, Math.floor(t.duration || 0) - 1));
    render();
  });
  $(".ext-cancel", box).addEventListener("click", () => {
    extendDrafts.delete(t.id);
    render();
  });
  const go = $(".ext-go", box);
  go.disabled = !!d.busy;
  go.textContent = d.busy ? "Sending…" : "Extend track";
  go.addEventListener("click", () => submitExtend(job, t));
  if (d.error) {
    const err = document.createElement("p");
    err.className = "job-err";
    err.textContent = d.error;
    box.append(err);
  }
}

function render() {
  const focus = snapshotFocus();
  const wrap = $("#jobs");
  wrap.replaceChildren();
  $("#empty").hidden = jobs.length > 0;
  for (const job of jobs) {
    const el = $("#jobTpl").content.firstElementChild.cloneNode(true);
    const done = job.status === "SUCCESS";
    const failed = job.status === "TIMEOUT" || FAIL_STATUSES.has(job.status) || /FAIL|ERROR/.test(job.status);
    el.classList.toggle("done", done);
    el.classList.toggle("failed", failed);
    $(".job-title", el).textContent = job.title;
    $(".job-sub", el).textContent = job.sub;
    const badge = $(".badge", el);
    badge.textContent = job.status === "TIMEOUT" ? "Timed out" : STATUS_LABEL[job.status] || job.status;
    badge.className = "badge " + (done ? "ok" : failed ? "err" : "run");
    $(".job-err", el).textContent = job.error || "";

    for (const t of job.tracks) {
      const card = $("#trackTpl").content.firstElementChild.cloneNode(true);
      card.dataset.id = t.id || "";
      const src = t.audio || t.stream;
      if (t.image) $("img", card).src = t.image;
      $(".t-title", card).textContent = t.title;
      $(".t-tags", card).textContent = t.tags;
      $(".t-dur", card).textContent = t.audio ? fmtDur(t.duration) : t.stream ? "Streaming preview…" : "Rendering…";
      const cover = $(".cover", card);
      cover.disabled = !src;
      cover.addEventListener("click", () => play(t, src));
      if (nowPlaying === t.id) card.classList.add("playing");
      const dl = $(".dl", card);
      if (t.audio) {
        dl.href = t.audio;
        dl.setAttribute("download", `${t.title}.mp3`);
      } else dl.setAttribute("aria-disabled", "true");
      const lyrBtn = $(".lyr", card);
      const pre = $(".t-lyrics", card);
      if (t.lyrics && !/^\s*$/.test(t.lyrics)) {
        pre.textContent = t.lyrics;
        pre.hidden = !lyricsOpen.has(t.id);
        lyrBtn.addEventListener("click", () => {
          pre.hidden = !pre.hidden;
          if (pre.hidden) lyricsOpen.delete(t.id);
          else lyricsOpen.add(t.id);
        });
      } else lyrBtn.hidden = true;
      renderExtend(card, job, t);
      $(".tracks", el).append(card);
    }
    wrap.append(el);
  }
  restoreFocus(focus);
}

function play(t, src) {
  if (!src) return;
  const audio = $("#audio");
  $("#player").hidden = false;
  $("#pTitle").textContent = t.title;
  $("#pTags").textContent = t.tags;
  $("#pCover").src = t.image || "";
  if (audio.src !== src) audio.src = src;
  nowPlaying = t.id;
  audio.play().catch(() => {});
  render();
}

// ---------- init ----------
function init() {
  $$(".tab").forEach((t) => t.addEventListener("click", () => setMode(t.dataset.mode)));
  $("#instrumental").addEventListener("change", syncInstrumental);
  $("#genForm").addEventListener("submit", onGenerate);
  $("#writeLyricsBtn").addEventListener("click", onWriteLyrics);
  $("#lockBtn").addEventListener("click", askPasscode);
  $("#clearBtn").addEventListener("click", () => {
    if (!jobs.length || !confirm("Remove all tracks from this list? (Download any you want to keep first.)")) return;
    timers.forEach(clearTimeout);
    timers.clear();
    jobs = [];
    save();
    render();
  });

  for (const id of ["styleWeight", "weirdnessConstraint", "variety"]) {
    const el = $("#" + id);
    const out = $(`output[data-for="${id}"]`);
    el.addEventListener("input", () => {
      el.dataset.touched = "1";
      out.textContent = el.value;
    });
  }

  const ideaWrap = $("#ideaChips");
  for (const idea of IDEAS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = idea.split(",")[0];
    b.title = idea;
    b.addEventListener("click", () => ($("#prompt").value = idea));
    ideaWrap.append(b);
  }
  for (const wrap of $$("[data-style-target]")) {
    const input = $("#" + wrap.dataset.styleTarget);
    for (const s of STYLES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = "+ " + s;
      b.addEventListener("click", () => {
        const cur = input.value.trim();
        input.value = cur ? `${cur}, ${s}` : s;
      });
      wrap.append(b);
    }
  }

  // record mode: multitrack mixer
  mixer = new Mixer({
    list: $("#trackList"),
    tpl: $("#layerTpl"),
    meterCanvas: $("#recWave"),
    onChange: syncMixerUi,
    onTime: (sec) => ($("#recTime").textContent = fmtClock(sec)),
    onLyric: appendLyricLine,
    onInterim: (t) => {
      if (t) $("#recHint").textContent = `“${t}”`;
    },
    onError: (m) => setMsg(m, true),
  });
  $("#recBtn").addEventListener("click", onBigRecord);
  $("#mixPlay").addEventListener("click", () => (mixer.isPlaying ? mixer.stop() : mixer.start()));
  $("#fileInput").addEventListener("change", onFilePicked);
  $("#trackList").addEventListener("click", (e) => {
    if (e.target.closest(".layer-rec")) setMsg("");
  });
  if (!canRecord()) $("#recHint").textContent = "Recording isn't supported in this browser — add audio files instead.";
  window.addEventListener("beforeunload", (e) => {
    if (mixer.tracks.length) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  syncMixerUi();

  // producer notes
  $("#notes").addEventListener("input", syncNotes);
  $("#targetLen").addEventListener("input", () => {
    $("#targetLen").dataset.auto = "";
    syncNotes();
  });
  $$(".len-chips .chip").forEach((c) =>
    c.addEventListener("click", () => {
      $("#targetLen").value = c.dataset.len;
      $("#targetLen").dataset.auto = "";
      syncNotes();
    })
  );
  syncNotes();

  $$('input[name="recUse"]').forEach((r) =>
    r.addEventListener("change", () => {
      syncNotes();
      const a = recUse();
      $(".ref-only").hidden = a !== "reference";
      $("#recAudioWeight").closest(".slider").hidden = a === "reference";
    })
  );
  $("#recAudioWeight").addEventListener("input", (e) => {
    $('output[data-for="recAudioWeight"]').textContent = Number(e.target.value).toFixed(2);
  });

  render();
  for (const j of jobs) if (!isTerminal(j.status) && j.status !== "TIMEOUT") poll(j.taskId);
  refreshCredits();
}

init();
