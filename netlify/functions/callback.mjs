// SunoAPI requires a callBackUrl on every task. The app polls for status instead,
// so this endpoint simply acknowledges callbacks with a 200.
export default async () =>
  new Response(JSON.stringify({ code: 200, msg: "received" }), {
    headers: { "content-type": "application/json" },
  });

export const config = { path: "/api/callback" };
