# Stay Optimal Records — AI Music Studio

A web app that lets users generate original songs with AI, powered by [SunoAPI.org](https://docs.sunoapi.org/).

- **Simple mode**: describe a vibe ("late-night R&B about city lights…"), and lyrics are written for you.
- **Custom mode**: set the title, style, and your own lyrics, plus advanced controls (styles to avoid, vocal gender, length, style adherence, weirdness, variety).
- **Record mode with a 5-layer mixer**: stack up to 5 recordings (lead vocal, harmonies, ad-libs, hums, spoken ideas) or uploaded audio files.
  - Recording a new layer plays the existing layers back so you can sing along (wear headphones). Recording latency is compensated automatically, and each layer has a **Nudge** slider (±500 ms) to fix timing by hand.
  - Each layer has a name, volume, **M**ute, **S**olo, re-record, delete, and a 📝 toggle that transcribes that layer's words into the lyrics box (Chrome, Edge, Safari). It's on by default only for the first layer, so ad-libs don't clutter the lyrics.
  - **Play mix** previews all audible layers with a playhead. When you generate, the layers are mixed down in the browser into one MP3 and uploaded. If the mix hasn't changed, the earlier upload is reused.
  - Then choose one:
    - **Remix my voice**: keeps your melody and flow, then re-sings and produces it in a new style (`upload-cover`).
    - **Keep my vocals, add the beat**: your real voice stays and a full backing track is built around it (`add-instrumental`).
    - **Use it as inspiration**: your mix guides the vibe and flow of a brand-new song (`generate` with `audioUrls`).
- **Producer notes** (all modes): a box for telling the AI what to keep in mind, e.g. "make it 3 minutes, big 808 drop at 0:45, guitar solo around 2:00, fade out at the end."
  - **Target length** (m:ss, with quick 1:00–4:00 buttons) is filled in automatically from phrases like "extend it into 3 mins". In Custom mode and Record → Remix it's sent as SunoAPI's exact `duration` (max 6:00). In the other modes it's sent as a written request.
  - Timestamps in the notes are shown as cue chips (e.g. `0:45 big 808 drop`, `2:30–2:50 just drums`) so you can check what the AI will be told. The notes go to the AI as direction alongside the style. It follows them closely, but not to the exact second.
- **⏩ Extend** on any finished track: pick a start time (type it, press "Use player time" after pausing the player at the right moment, or press "From the end"). Then describe what should happen from there and optionally add lyrics for the new part. Everything before that point stays, which makes it the precise way to lengthen a song or change what happens at a specific moment (`/api/v1/generate/extend`, using the same model as the original).
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
  - `POST /api/generate` with `action: "cover" | "add-instrumental" | "reference"` handles the three recording modes, and `action: "extend"` continues a finished track from a timestamp (`/api/v1/generate/extend`). Every action accepts `notes` and `targetSeconds`.
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
