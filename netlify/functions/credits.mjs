import { handle, suno } from "../lib/suno.mjs";

export default async (req) => handle(req, () => suno("/api/v1/generate/credit"));

export const config = { path: "/api/credits" };
