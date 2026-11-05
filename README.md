# Stay Optimal Records — AI Music Studio

A web app that lets users generate original songs with AI, powered by [SunoAPI.org](https://docs.sunoapi.org/).

- **Simple mode**: describe a vibe ("late-night R&B about city lights…"), and lyrics are written for you.
- **Custom mode**: set the title, style, and your own lyrics, plus advanced controls (styles to avoid, vocal gender, length, style adherence, weirdness, variety).
- **Record mode**: sing, hum, rap or speak an idea into the mic (or upload an audio file), with a live level meter and playback. What you say can be transcribed straight into the lyrics box (Chrome, Edge, Safari). Then choose one:
  - **Remix my voice**: keeps your melody and flow, then re-sings and produces it in a new style (`upload-cover`).
  - **Keep my vocals, add the beat**: your real voice stays and a full backing track is built around it (`add-instrumental`).
  - **Use it as inspiration**: your recording guides the vibe and flow of a brand-new song (`generate` with `audioUrls`).
- **Write lyrics with AI**: generates lyrics from a short topic.
- Models: V6 (default), V6 Wild, V6 Mini.
- Each generation produces 2 takes. The first one can be streamed before the final MP3 is ready.
- A track library is saved in the browser, with an in-page player and MP3 download. SunoAPI keeps files for 14 days.
- Shows your remaining SunoAPI credits.

## Stack

- `public/`: static frontend (HTML/CSS/vanilla JS, no build step)
- `netlify/functions/`: serverless proxy to SunoAPI so the **API key stays on the server**
  - `POST /api/generate` → `POST /api/v1/generate`
  - `GET  /api/status?taskId=` → `GET /api/v1/generate/record-info`
  - `POST /api/lyrics`, `GET /api/lyrics?taskId=` → `/api/v1/lyrics`, `/api/v1/lyrics/record-info`
  - `GET  /api/credits` → `GET /api/v1/generate/credit`
  - `POST /api/upload` → File Upload API `POST /api/file-base64-upload` (recordings are compressed to MP3 in the browser with the vendored `public/vendor/lame.min.js`, LGPL, to stay under Netlify's ~6 MB request limit; uploads are kept for 3 days)
  - `POST /api/generate` with `action: "cover" | "add-instrumental" | "reference"` handles the three recording modes
  - `POST /api/callback`: no-op receiver for SunoAPI's required `callBackUrl` (the app polls instead)

## Deploy on Netlify

1. In Netlify: **Add new site → Import from Git** → pick this repo, branch `main`.
   The build settings come from `netlify.toml`, so you don't need to enter a build command.
2. **Site configuration → Environment variables**, then add:
   - `SUNO_API_KEY`: your SunoAPI.org key (required)
   - `APP_PASSCODE`: optional. If set, visitors must enter this passcode before they can generate, which stops strangers from spending your credits.
3. Redeploy so the functions pick up the variables.

## Local development

```bash
npm i -g netlify-cli
cp .env.example .env   # fill in SUNO_API_KEY
netlify dev
```
