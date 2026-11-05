import { handle, suno, callbackUrl, json } from "../lib/suno.mjs";

const MODELS = new Set(["V6", "V6_WILD", "V6_MINI"]);
const clampNum = (v, min, max) => {
  if (v === "" || v === null || v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
};
const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const weight = (v) => {
  const n = clampNum(v, 0, 1);
  return n === undefined ? undefined : Math.round(n * 100) / 100;
};
const fail = (msg) => Object.assign(new Error(msg), { status: 400 });

function uploadUrlOf(input) {
  const u = str(input.uploadUrl, 2000);
  if (!u) throw fail("Record or upload your audio first.");
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    throw fail("Invalid recording URL.");
  }
  if (parsed.protocol !== "https:") throw fail("Invalid recording URL.");
  return parsed.toString();
}

function prune(body) {
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

// Text-to-music: POST /api/v1/generate
function buildGenerate(input, base) {
  const customMode = !!input.customMode;
  const instrumental = !!input.instrumental;
  const body = { ...base, customMode, instrumental };

  if (customMode) {
    body.title = str(input.title, 80);
    body.style = str(input.style, 1000);
    body.negativeTags = str(input.negativeTags, 1000);
    if (!instrumental) body.lyrics = str(input.lyrics, 5000);
    if (input.vocalGender === "m" || input.vocalGender === "f") body.vocalGender = input.vocalGender;
    const duration = clampNum(input.duration, 10, 360);
    if (duration) body.duration = Math.round(duration);
    body.styleWeight = weight(input.styleWeight);
    body.weirdnessConstraint = weight(input.weirdnessConstraint);
    if (!instrumental) body.audioWeight = weight(input.audioWeight);
    const variety = clampNum(input.variety, 0, 4);
    if (variety !== undefined) body.variety = Math.round(variety);
    if (!body.style && !body.lyrics && !body.negativeTags) {
      throw fail("Custom mode needs at least a style, lyrics, or tags to avoid.");
    }
  } else {
    body.prompt = str(input.prompt, 3000);
    body.style = str(input.style, 1000);
    if (!body.prompt && !body.style) throw fail("Describe the song you want.");
  }
  return { path: "/api/v1/generate", body };
}

// Recording -> re-sung in a new style, keeping the melody: POST /api/v1/generate/upload-cover
function buildCover(input, base) {
  return {
    path: "/api/v1/generate/upload-cover",
    body: {
      ...base,
      uploadUrl: uploadUrlOf(input),
      instrumental: false,
      title: str(input.title, 80),
      style: str(input.style, 1000),
      lyrics: str(input.lyrics, 5000),
      audioWeight: weight(input.audioWeight),
      vocalGender: input.vocalGender === "m" || input.vocalGender === "f" ? input.vocalGender : undefined,
    },
  };
}

// Keep the user's real vocals, build a backing track: POST /api/v1/generate/add-instrumental
// title, tags and negativeTags are required by the API, so sensible defaults are filled in.
function buildAddInstrumental(input, base) {
  return {
    path: "/api/v1/generate/add-instrumental",
    body: {
      ...base,
      uploadUrl: uploadUrlOf(input),
      title: str(input.title, 80) || "My Recording",
      tags: str(input.style, 1000) || "full band, polished modern production",
      negativeTags: str(input.negativeTags, 1000) || "low quality, distorted, off-key",
      lyrics: str(input.lyrics, 5000),
      audioWeight: weight(input.audioWeight),
    },
  };
}

// Recording used only as a reference for vibe & flow of a new song: POST /api/v1/generate (non-custom, audioUrls)
function buildReference(input, base) {
  const desc = [str(input.title, 80), str(input.prompt, 2000)].filter(Boolean).join(" — ");
  return {
    path: "/api/v1/generate",
    body: {
      ...base,
      customMode: false,
      instrumental: false,
      audioUrls: [uploadUrlOf(input)],
      prompt: desc || undefined,
      style: str(input.style, 1000),
      lyrics: str(input.lyrics, 5000),
    },
  };
}

const BUILDERS = {
  generate: buildGenerate,
  cover: buildCover,
  "add-instrumental": buildAddInstrumental,
  reference: buildReference,
};

export default async (req) => {
  if (req.method !== "POST") return json({ code: 405, msg: "Use POST" }, 405);
  let input;
  try {
    input = await req.json();
  } catch {
    return json({ code: 400, msg: "Invalid JSON body" }, 400);
  }
  const build = BUILDERS[input.action || "generate"];
  if (!build) return json({ code: 400, msg: "Unknown action" }, 400);
  let spec;
  try {
    const base = {
      model: MODELS.has(input.model) ? input.model : "V6",
      callBackUrl: callbackUrl(req),
    };
    spec = build(input, base);
  } catch (err) {
    return json({ code: 400, msg: err.message }, 400);
  }
  return handle(req, () => suno(spec.path, { method: "POST", body: prune(spec.body) }));
};

export const config = { path: "/api/generate" };
