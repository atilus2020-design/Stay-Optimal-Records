import { handle, suno, json, UPLOAD_BASE } from "../lib/suno.mjs";

// POST /api/upload { base64Data: "data:audio/mpeg;base64,...", fileName }
// Forwards a user's recording to SunoAPI's File Upload API and returns a public URL
// that the cover / add-instrumental / reference endpoints can read.
// Netlify caps function request bodies at ~6 MB, so the browser compresses to MP3 first.
const MAX_CHARS = 5_800_000;

export default async (req) => {
  if (req.method !== "POST") return json({ code: 405, msg: "Use POST" }, 405);
  let input;
  try {
    input = await req.json();
  } catch {
    return json({ code: 413, msg: "Recording too large or invalid. Try a shorter take." }, 400);
  }
  const data = typeof input.base64Data === "string" ? input.base64Data : "";
  if (!/^data:audio\/[\w.+-]+;base64,/.test(data)) return json({ code: 400, msg: "Expected an audio recording." }, 400);
  if (data.length > MAX_CHARS) return json({ code: 413, msg: "Recording is too large. Try a shorter take." }, 413);
  const fileName = String(input.fileName || "recording.mp3").replace(/[^\w.-]/g, "_").slice(0, 80);

  return handle(req, async () => {
    const res = await suno("/api/file-base64-upload", {
      method: "POST",
      base: UPLOAD_BASE,
      body: { base64Data: data, uploadPath: "stay-optimal-recordings", fileName },
    });
    if (res.code !== 200 && res.success !== true) return res;
    const url = res.data?.downloadUrl || res.data?.fileUrl;
    if (!url) return { code: 500, msg: "Upload succeeded but no file URL was returned." };
    return { code: 200, msg: "success", data: { url, expiresAt: res.data?.expiresAt || null } };
  });
};

export const config = { path: "/api/upload" };
