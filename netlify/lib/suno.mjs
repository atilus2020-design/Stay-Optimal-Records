// Shared helpers for talking to SunoAPI.org from Netlify Functions.
// The API key lives ONLY in the server environment (SUNO_API_KEY) and is never sent to the browser.

export const SUNO_BASE = process.env.SUNO_API_BASE || "https://api.sunoapi.org";

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// Optional shared passcode so strangers can't burn your credits.
// Set APP_PASSCODE in Netlify to require it; leave unset for open access.
export function checkAuth(req) {
  const required = process.env.APP_PASSCODE;
  if (!required) return null;
  const given = req.headers.get("x-app-passcode") || "";
  if (given !== required) return json({ code: 401, msg: "Invalid or missing passcode." }, 401);
  return null;
}

export function getKey() {
  const key = process.env.SUNO_API_KEY;
  if (!key) throw new Error("SUNO_API_KEY is not configured on the server.");
  return key;
}

export async function suno(path, { method = "GET", body, query } = {}) {
  const url = new URL(path, SUNO_BASE);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${getKey()}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try {
    data = await res.json();
  } catch {
    data = { code: res.status, msg: `Upstream returned non-JSON (HTTP ${res.status}).` };
  }
  return data;
}

// SunoAPI requires a callBackUrl. We poll for results, so point it at our no-op callback.
export function callbackUrl(req) {
  const base = process.env.URL || new URL(req.url).origin;
  return `${base}/api/callback`;
}

export async function handle(req, fn) {
  const denied = checkAuth(req);
  if (denied) return denied;
  try {
    return json(await fn());
  } catch (err) {
    return json({ code: 500, msg: err.message || "Server error" }, 500);
  }
}
