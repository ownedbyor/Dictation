// dictation-words: generates a Hebrew spelling dictation with Gemini.
// POST { level: "easy" | "medium" | "hard", n: 5..50 }
// → 200 { items: [{ w, s, t }], model }
// Requires the secret GEMINI_API_KEY. Optional: GEMINI_MODELS (comma-separated, tried in order).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEFAULT_MODELS = "gemini-3.8-flash,gemini-3-flash-preview,gemini-2.5-flash";

const LEVELS: Record<string, string> = {
  easy: "short, very common everyday words (2-5 letters) with one tricky spot each, and very simple sentences",
  medium: "common 4th-grade words with the typical pitfalls listed below",
  hard: "longer words (6+ letters, plurals and verb forms allowed) that a 10-12 year old knows and uses, often with two tricky spots, and slightly richer sentences. Hard means harder to SPELL, never rare or obscure",
};

const LETTER_NAMES =
  "אלף, בית, גימל, דלת, הא, וו, זין, חית, טית, יוד, כף, למד, מם, נון, סמך, עין, פא, צדי, קוף, ריש, שין, תו, " +
  "כף סופית, מם סופית, נון סופית, פא סופית, צדי סופית";

const SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      word: { type: "STRING" },
      sentence: { type: "STRING" },
      tip: { type: "STRING" },
    },
    required: ["word", "sentence", "tip"],
  },
};

type Item = { word: string; sentence: string; tip: string };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function generatePrompt(level: string, n: number): string {
  return `Create a Hebrew spelling dictation (הכתבה) for a 4th-grade girl (age 9-10) who is learning to write without spelling mistakes.

Number of items: exactly ${n}. All words must be different.
Difficulty: ${LEVELS[level]}.

WORD RULES:
- Only real, common Hebrew words that children actually know. Never invent words; never rare, archaic or technical words.
- Each word contains at least one spelling pitfall: א/ע, ט/ת, כ/ח, ק/כ, ב/ו, ס/ש, final letters, or full spelling (כתיב מלא) with ו and י. Mix the pitfalls across the list.
- Standard modern Hebrew full spelling without niqqud, per the Academy of the Hebrew Language. No proper nouns, numbers, slang, or words with more than one accepted spelling.
- Vary the sentence topics (school, nature, animals, family, food, sports, the sea, holidays, the city, friends, weather, trips).

FIELDS:
- word: the word without niqqud, exactly as it should be written.
- sentence: a short, natural, grammatically correct Hebrew sentence (5-9 words), no niqqud, containing word exactly once. Prefix letters (ה, ו, ב, ל, מ, ש, כ) may be attached to it as in normal writing, never separated by a space.
- tip: "כותבים <letter name>, כמו ב<another real word from the SAME root containing that letter>", or only "כותבים <letter name>" when there is no such word. Allowed letter names: ${LETTER_NAMES}. Never invent roots or associations.

Check every item before answering.`;
}

function reviewPrompt(items: Item[]): string {
  return `You are a strict Hebrew language editor and an experienced elementary-school teacher. Review this spelling-dictation list for a 4th-grade girl and return the corrected list with the same number of items.

1. word must be a real, common Hebrew word children know, correctly spelled in full spelling without niqqud. Replace rare, invented, misspelled or ambiguous words with a new valid item of the same difficulty, without duplicates.
2. sentence must be natural, grammatical Hebrew (5-9 words, no niqqud) and contain word exactly as written (an attached prefix letter is fine). If it uses another form of the word, rewrite the sentence.
3. tip must be "כותבים <letter name>, כמו ב<related word>" or "כותבים <letter name>". The letter must appear in word at its tricky spot. The related word must share the SAME root and contain that letter; if you are not completely sure (e.g. ארוחה/לאכול or תיאטרון/להציג do NOT share a root), keep only "כותבים <letter name>". Allowed letter names: ${LETTER_NAMES}.

LIST:
${JSON.stringify(items)}`;
}

async function callGemini(model: string, key: string, prompt: string): Promise<Item[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0.9 },
      }),
    },
  );
  if (!res.ok) throw new Error(`${model}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error(`${model}: response is not an array`);
  return parsed;
}

const hebrewOnly = (s: string) => String(s ?? "").replace(/[^א-ת]/g, "");

function clean(items: Item[], n: number) {
  const seen = new Set<string>();
  const out: { w: string; s: string; t: string }[] = [];
  for (const it of items) {
    const w = String(it?.word ?? "").trim();
    const s = String(it?.sentence ?? "").trim();
    const t = String(it?.tip ?? "").trim();
    const key = hebrewOnly(w);
    if (!key || key !== w.replace(/[֑-ׇ]/g, "")) continue; // single Hebrew word, no spaces or Latin
    if (!s.includes(w) || seen.has(key)) continue;
    seen.add(key);
    out.push({ w, s, t });
    if (out.length >= n) break;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return json({ error: "missing_key" }, 503);

  const body = await req.json().catch(() => ({}));
  const level = ["easy", "medium", "hard"].includes(body?.level) ? body.level : "medium";
  const n = Math.min(50, Math.max(5, parseInt(body?.n, 10) || 20));
  const models = (Deno.env.get("GEMINI_MODELS") || DEFAULT_MODELS).split(",").map((m) => m.trim()).filter(Boolean);

  const errors: string[] = [];
  for (const model of models) {
    try {
      const draft = await callGemini(model, key, generatePrompt(level, n));
      let reviewed = draft;
      try {
        reviewed = await callGemini(model, key, reviewPrompt(draft));
      } catch (e) {
        errors.push(`review ${String(e)}`); // keep the draft if the review pass fails
      }
      const items = clean(reviewed, n);
      if (items.length >= Math.min(5, n)) return json({ items, model });
      errors.push(`${model}: only ${items.length} valid items`);
    } catch (e) {
      errors.push(String(e));
    }
  }
  return json({ error: "generation_failed", details: errors.slice(-3) }, 502);
});
