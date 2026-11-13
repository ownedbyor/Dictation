# Dictation Notebook (מחברת הכתבה)

Spelling-dictation practice app for a 4th-grade girl, in Hebrew and English. Mobile-first PWA, installed on a phone from the home screen.

## Architecture

| Part | Where | Notes |
|---|---|---|
| Frontend | `index.html` (single file: HTML + CSS + vanilla JS) | Hosted on GitHub Pages from `main`. Every push to `main` goes live in ~1 min. |
| PWA shell | `manifest.webmanifest`, `sw.js`, `icons/` | Network-first service worker; English mode works offline. |
| Natural voice | `supabase/functions/dictation-tts/index.ts`, `phrases.js` | Google Cloud TTS (Chirp 3 HD `Kore`, secret `GOOGLE_TTS_API_KEY`) → MP3 cached in the public Storage bucket `tts` at `<lang>/<sha256('\|gc1\|'+lang+'\|'+text)>.mp3`. Without that secret it falls back to Gemini TTS (WAV, tiny free daily quota). The client computes that URL itself and plays cached clips straight from storage; uncached clips are rendered on demand; anything not ready within ~2.5 s falls back to the device voice. |
| Hebrew word generation | `supabase/functions/dictation-words/index.ts` | Supabase Edge Function → Gemini (generate + review pass, JSON schema output). Secret: `GEMINI_API_KEY`. Optional `GEMINI_MODELS` (comma-separated fallback chain). |
| Progress sync | Supabase table `public.progress` + RPCs `get_progress` / `save_progress` | See `supabase/migrations/`. The browser only knows the anon key; RLS blocks direct table access, so a record is reachable only by its code. |

Supabase project ref: `ugtqcfrtstfpzbhxybdm` (region eu-central-1).

## Conventions

- Keep the frontend dependency-free (no build step, no framework): `index.html` plus `phrases.js`. If it grows past ~1,500 lines, split JS into ES modules under `js/` — still no bundler.
- UI language: Hebrew, RTL. Copy addresses the child in feminine second person (כתבי, הקשיבי).
- All colors come from CSS custom properties in `:root`, with dark-mode overrides in the `prefers-color-scheme: dark` block.
- Use `el.hidden` to toggle visibility (`[hidden]{display:none!important}` is global).
- localStorage keys are prefixed `dict_` and every access is wrapped in try/catch (`store.get` / `store.set`).
- Words are objects `{ w, s, t }` (word, sentence, tip). Hebrew items from the server may add `wn` / `sn`: the word and sentence with niqqud, used only for reading aloud (`PH.item`), never shown on screen. English items add `g:'en'`, `h` (Hebrew meaning), `v` (digit) or `c` (hex color), optional `alt` (accepted alternatives).
- Answer comparison ignores niqqud / case / punctuation via `norm(text, lang)`.
- Hard-word keys: Hebrew letters only for Hebrew, `en:<word>` for English. Mastered words become tombstones `{ del:true, u }` so deletions sync across devices.

## Speech

- Every spoken line is a list of parts `[{ t, g }]` passed to `speak(parts, rate)`. Prefer fixed phrases from `phrases.js` (letter names carry full niqqud so they are read correctly).
- Corrections: "כִּמְעַט!", then (if exactly one letter is wrong) "כּוֹתְבִים חֵית. וְלֹא כָּף.", then the correct word spelled letter by letter, one clip per letter ("כּוֹתְבִים כָּךְ: מֵם. חֵית. ..."). Parts with `hl:k` highlight letter k of the on-screen word while it is read. English corrections are spoken in Hebrew with only the word and the letters in English ("כִּמְעַט! כּוֹתְבִים | house. | עִם | E. | וְלֹא עִם | A. | כּוֹתְבִים כָּךְ: | H. | O. ..."), each piece its own clip in its own language.
- Fixed clips are pre-rendered by the `tts-warm` cron job (queue `private.tts_warm`, unschedules itself when done) or by `node tools/warm-phrases.mjs`. After changing any phrase text, re-run the warm script.
- Gemini TTS on a free key allows only ~15 clips per model per day (HTTP 429 afterwards); that is why Google Cloud TTS is the primary provider.

## English word bank

Fixed, hand-checked lists `EN_NUM` (1–20), `EN_COL` (11 colors) and `EN_WRD` (class words, emoji cue `e`) in `index.html`. To add a topic: add an array in the same shape, a button in `#topics`, and a branch in `enList()`. Every sentence must contain its word exactly.

## Deploying

- Frontend: commit and push to `main`.
- Edge Functions: `supabase functions deploy dictation-words --project-ref ugtqcfrtstfpzbhxybdm` (same for `dictation-tts`)
- Bump `CACHE` in `sw.js` when adding files to the precached shell.

## Testing checklist

- Hebrew: each level loads words; a wrong answer highlights the wrong letters and reads the correction aloud.
- English: numbers, colors, all; `grey` accepted for `gray`; capitals not counted as mistakes.
- Next word auto-plays audio after "למילה הבאה".
- Sync: same code on two browsers merges stars, history and hard words.
- Install on iPhone (Safari → Share → Add to Home Screen) and Android (Chrome → Install app).
