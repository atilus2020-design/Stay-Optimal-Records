import { handle, suno, json } from "../lib/suno.mjs";

export default async (req) => {
  const taskId = new URL(req.url).searchParams.get("taskId");
  if (!taskId) return json({ code: 400, msg: "taskId is required" }, 400);
  return handle(req, () => suno("/api/v1/generate/record-info", { query: { taskId } }));
};

export const config = { path: "/api/status" };
