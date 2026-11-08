// Helpers for the Producer notes box: parse "m:ss" times, spot a requested song length in free text,
// and pull out timestamped cues ("big drop at 0:45") so the user can see what the AI will be told.

export const MAX_DURATION = 360; // SunoAPI `duration` upper bound (seconds)

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const num = (s) => (s in WORDS ? WORDS[s] : Number(String(s).replace(",", ".")));

export const fmtClock = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

// "3:00" -> 180, "90" -> 90, "2m" / "2 min" -> 120, "1m30" / "1m30s" -> 90. Returns NaN if unreadable.
export function parseClock(text) {
  const s = String(text || "").trim().toLowerCase();
  if (!s) return NaN;
  let m = s.match(/^(\d{1,2}):([0-5]\d)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = s.match(/^(\d+(?:[.,]\d+)?)\s*(?:m|min|mins|minutes?)\s*(?:(\d{1,2})\s*s?)?$/);
  if (m) return Math.round(num(m[1]) * 60 + (m[2] ? Number(m[2]) : 0));
  m = s.match(/^(\d+(?:[.,]\d+)?)\s*(?:s|sec|secs|seconds?)?$/);
  if (m) return Math.round(num(m[1]));
  return NaN;
}

// Find a requested total length: "extend it to 3 minutes", "make it 2:30 long", "a 4 min song", "180 seconds long".
export function detectLength(text) {
  const t = String(text || "").toLowerCase();
  const N = "(\\d+(?:[.,]\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)";
  const MIN = "(?:-|\\s)?(?:minutes?|mins?)\\b";
  const Q = "(?:about\\s+|around\\s+|roughly\\s+|approximately\\s+|a\\s+full\\s+|a\\s+)?";
  const patterns = [
    // "...to/into 3 minutes", "...into 2:30" — the number after to/into is the goal, not the current length
    [new RegExp(`\\b(?:to|into)\\s+${Q}${N}${MIN}`), "min"],
    [new RegExp(`\\b(?:to|into)\\s+${Q}(\\d{1,2}):([0-5]\\d)\\b(?!\\s*(?:mark|in\\b))`), "clock"],
    // "make it 3 minutes", "keep it about 2:30"
    [new RegExp(`\\b(?:make|turn|keep|have)\\s+(?:it|the\\s+(?:song|track))\\s+(?:be\\s+)?${Q}${N}${MIN}`), "min"],
    [new RegExp(`\\b(?:make|turn|keep|have)\\s+(?:it|the\\s+(?:song|track))\\s+(?:be\\s+)?${Q}(\\d{1,2}):([0-5]\\d)\\b`), "clock"],
    // "a 4 minute song" (but not "this one minute track", which describes the current length)
    [new RegExp(`(?<!\\b(?:this|my|the|current|existing|our)\\s)${N}${MIN}\\s*(?:long|track|song|length|version|full)`), "min"],
    [new RegExp(`\\b(?:length|duration|runtime|total)\\b[^.\\n]{0,15}?${N}${MIN}`), "min"],
    [/\b(\d{1,2}):([0-5]\d)\s*(?:long|track|song|length|total)\b/, "clock"],
    [/\b(?:length|duration|runtime)\b[^.\n]{0,15}?\b(\d{1,2}):([0-5]\d)\b/, "clock"],
    [/\b(\d{2,3})\s*(?:seconds?|secs?)\s*(?:long|track|song|length)\b/, "sec"],
  ];
  for (const [re, kind] of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const secs = kind === "min" ? num(m[1]) * 60 : kind === "clock" ? Number(m[1]) * 60 + Number(m[2]) : Number(m[1]);
    if (secs >= 10 && secs <= 20 * 60) return Math.round(secs);
  }
  return null;
}

// Pull timed cues out of the notes, in time order:
// "big 808 drop at 0:45" -> {secs:45, text:"big 808 drop"}, "0:10 to 0:30 just drums" -> one range cue.
export function extractCues(text) {
  const TIME = /\b(\d{1,2}):([0-5]\d)\b/g;
  const toSecs = (m) => Number(m[1]) * 60 + Number(m[2]);
  // Trim connector words only at the edges ("big drop at" -> "big drop"), keeping "switch to a half-time beat".
  const FILLER = "(?:at|around|about|by|from|starting|start|until|till|to|@|the|mark|and|then|right|exactly)";
  const edge = new RegExp(`^(?:[\\s,:–—-]|${FILLER}\\b)+|(?:[\\s,:–—-]|\\b${FILLER})+$`, "gi");
  const clean = (s) => s.replace(/\s+/g, " ").replace(edge, "").trim();
  const cues = [];
  // Sentences, then comma clauses; "At 0:45, a big drop" borrows the following clause.
  const parts = String(text || "").split(/[.;\n]+/).flatMap((s) => s.split(/,/));
  parts.forEach((clause, i) => {
    const hits = [...clause.matchAll(TIME)].map((m) => ({ start: m.index, end: m.index + m[0].length, secs: toSecs(m) }));
    // Merge "0:10 to 0:30" / "0:10-0:30" into a single range.
    const items = [];
    for (const h of hits) {
      const prev = items[items.length - 1];
      if (prev && /^\s*(?:to|-|–|—|until|till|through)\s*$/i.test(clause.slice(prev.end, h.start))) {
        prev.endSecs = h.secs;
        prev.end = h.end;
      } else items.push({ ...h });
    }
    let afterStyle = false; // once a cue's words follow its time ("at 0:45 big drop"), later ones do too
    items.forEach((it, k) => {
      const before = clean(clause.slice(k ? items[k - 1].end : 0, it.start));
      const after = clean(clause.slice(it.end, k + 1 < items.length ? items[k + 1].start : clause.length));
      // Prefer words before the time ("drop at 0:45"); with several times in one clause, each takes its own words.
      let what = afterStyle ? after || before : before || after;
      if (!before && after) afterStyle = true;
      if (!what && parts[i + 1] && !/\d:\d\d/.test(parts[i + 1])) what = clean(parts[i + 1]);
      if (what) cues.push({ secs: it.secs, endSecs: it.endSecs, text: what });
    });
  });
  return cues.sort((a, b) => a.secs - b.secs).slice(0, 12);
}
