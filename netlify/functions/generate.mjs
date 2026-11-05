import { handle, suno, callbackUrl, json } from "../lib/suno.mjs";

const MODELS = new Set(["V6", "V6_WILD", "V6_MINI"]);
const clampNum = (v, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
};
const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

// Builds a request body that follows the documented rules for /api/v1/generate.
function buildBody(input, req) {
  const customMode = !!input.customMode;
  const instrumental = !!input.instrumental;
  const model = MODELS.has(input.model) ? input.model : "V6";
  const body = { customMode, instrumental, model, callBackUrl: callbackUrl(req) };

  if (customMode) {
    body.title = str(input.title, 80);
    body.style = str(input.style, 1000);
    body.negativeTags = str(input.negativeTags, 1000);
    if (!instrumental) body.lyrics = str(input.lyrics, 5000);
    if (input.vocalGender === "m" || input.vocalGender === "f") body.vocalGender = input.vocalGender;
    const duration = clampNum(input.duration, 10, 360);
    if (duration) body.duration = Math.round(duration);
    for (const k of ["styleWeight", "weirdnessConstraint"]) {
      const v = clampNum(input[k], 0, 1);
      if (v !== undefined && input[k] !== "" && input[k] !== null) body[k] = Math.round(v * 100) / 100;
    }
    if (!instrumental && input.audioWeight !== "" && input.audioWeight != null) {
      const v = clampNum(input.audioWeight, 0, 1);
      if (v !== undefined) body.audioWeight = Math.round(v * 100) / 100;
    }
    if (input.variety !== "" && input.variety != null) {
      const v = clampNum(input.variety, 0, 4);
      if (v !== undefined) body.variety = Math.round(v);
    }
    if (!body.style && !body.lyrics && !body.negativeTags) {
      throw Object.assign(new Error("Custom mode needs at least a style, lyrics, or tags to avoid."), { status: 400 });
    }
  } else {
    body.prompt = str(input.prompt, 3000);
    body.style = str(input.style, 1000);
    if (!body.prompt && !body.style) {
      throw Object.assign(new Error("Describe the song you want."), { status: 400 });
    }
  }
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

export default async (req) => {
  if (req.method !== "POST") return json({ code: 405, msg: "Use POST" }, 405);
  let input;
  try {
    input = await req.json();
  } catch {
    return json({ code: 400, msg: "Invalid JSON body" }, 400);
  }
  let body;
  try {
    body = buildBody(input, req);
  } catch (err) {
    return json({ code: 400, msg: err.message }, 400);
  }
  return handle(req, () => suno("/api/v1/generate", { method: "POST", body }));
};

export const config = { path: "/api/generate" };
