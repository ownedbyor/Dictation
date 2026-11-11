# Dictation Notebook (מחברת הכתבה)

Spelling-dictation practice app for a 4th-grade girl, in Hebrew and English. Mobile-first PWA, installed on a phone from the home screen.

## Architecture

| Part | Where | Notes |
|---|---|---|
| Frontend | `index.html` (single file: HTML + CSS + vanilla JS) | Hosted on GitHub Pages from `main`. Every push to `main` goes live in ~1 min. |
| PWA shell | `manifest.webmanifest`, `sw.js`, `icons/` | Network-first service worker; English mode works offline. |
| Hebrew word generation | `supabase/functions/dictation-words/index.ts` | Supabase Edge Function → Gemini (generate + review pass, JSON schema output). Secret: `GEMINI_API_KEY`. Optional `GEMINI_MODELS` (comma-separated fallback chain). |
| Progress sync | Supabase table `public.progress` + RPCs `get_progress` / `save_progress` | See `supabase/migrations/`. The browser only knows the anon key; RLS blocks direct table access, so a record is reachable only by its code. |

Supabase project ref: `ugtqcfrtstfpzbhxybdm` (region eu-central-1).

## Conventions

- Keep `index.html` dependency-free (no build step, no framework). If it grows past ~1,500 lines, split JS into ES modules under `js/` — still no bundler.
- UI language: Hebrew, RTL. Copy addresses the child in feminine second person (כתבי, הקשיבי).
- All colors come from CSS custom properties in `:root`, with dark-mode overrides in the `prefers-color-scheme: dark` block.
- Use `el.hidden` to toggle visibility (`[hidden]{display:none!important}` is global).
- localStorage keys are prefixed `dict_` and every access is wrapped in try/catch (`store.get` / `store.set`).
- Words are objects `{ w, s, t }` (word, sentence, tip). English items add `g:'en'`, `h` (Hebrew meaning), `v` (digit) or `c` (hex color), optional `alt` (accepted alternatives).
- Answer comparison ignores niqqud / case / punctuation via `norm(text, lang)`.
- Hard-word keys: Hebrew letters only for Hebrew, `en:<word>` for English. Mastered words become tombstones `{ del:true, u }` so deletions sync across devices.

## English word bank

Fixed, hand-checked lists `EN_NUM` (1–20) and `EN_COL` (11 colors) in `index.html`. To add a topic: add an array in the same shape, a button in `#topics`, and a branch in `enList()`. Every sentence must contain its word exactly.

## Deploying

- Frontend: commit and push to `main`.
- Edge Function: `supabase functions deploy dictation-words --project-ref ugtqcfrtstfpzbhxybdm`
- Bump `CACHE` in `sw.js` when adding files to the precached shell.

## Testing checklist

- Hebrew: each level loads words; a wrong answer highlights the wrong letters and reads the correction aloud.
- English: numbers, colors, all; `grey` accepted for `gray`; capitals not counted as mistakes.
- Next word auto-plays audio after "למילה הבאה".
- Sync: same code on two browsers merges stars, history and hard words.
- Install on iPhone (Safari → Share → Add to Home Screen) and Android (Chrome → Install app).
