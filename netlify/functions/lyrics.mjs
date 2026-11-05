import { handle, suno, callbackUrl, json } from "../lib/suno.mjs";

// POST /api/lyrics            { prompt }   -> starts a lyrics task
// GET  /api/lyrics?taskId=... -> lyrics task details
export default async (req) => {
  if (req.method === "GET") {
    const taskId = new URL(req.url).searchParams.get("taskId");
    if (!taskId) return json({ code: 400, msg: "taskId is required" }, 400);
    return handle(req, () => suno("/api/v1/lyrics/record-info", { query: { taskId } }));
  }
  if (req.method !== "POST") return json({ code: 405, msg: "Use GET or POST" }, 405);
  let input;
  try {
    input = await req.json();
  } catch {
    return json({ code: 400, msg: "Invalid JSON body" }, 400);
  }
  const prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 200) : "";
  if (!prompt) return json({ code: 400, msg: "Tell us what the lyrics should be about." }, 400);
  return handle(req, () =>
    suno("/api/v1/lyrics", { method: "POST", body: { prompt, callBackUrl: callbackUrl(req) } })
  );
};

export const config = { path: "/api/lyrics" };
