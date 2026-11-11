// dictation-tts: turns a short text into natural speech and caches it in the public Storage bucket "tts".
//
// Providers (first one with a key wins):
//   1. Google Cloud Text-to-Speech  — secret GOOGLE_TTS_API_KEY. MP3, cached at <lang>/<sha256('|gc1|'+lang+'|'+text)>.mp3
//   2. Gemini TTS (free tier, small daily quota) — secret GEMINI_API_KEY. WAV, cached at <lang>/<sha256('|Kore|'+lang+'|'+text)>.wav
// The client computes the Google cache URL itself (VOICE 'gc1', '.mp3') and only calls this function on a miss.
//
// POST { text, lang?: "he" | "en" }   → 200 { url, cached }
// POST { warm: [{ text, lang }] }      → pre-renders up to 60 clips within ~2 minutes (fills the fixed-phrase cache)
// POST { probe: true, text?, lang? }   → renders `text` with every candidate voice under probe/ (for listening tests)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const BUCKET = "tts";
const MAX_CHARS = 400;

// Google voices, best first. Chirp 3 HD is the most natural; WaveNet is the fallback if a locale lacks it.
const GOOGLE_VOICES: Record<string, string[]> = {
  he: ["he-IL-Chirp3-HD-Kore", "he-IL-Wavenet-C", "he-IL-Wavenet-A"],
  en: ["en-US-Chirp3-HD-Kore", "en-US-Neural2-F", "en-US-Wavenet-F"],
};
const GOOGLE_LABEL = "gc1"; // bump to re-render every clip after changing voices

// Gemini (fallback). Probed 2026-11-11: 3.1-flash-tts-preview and 2.5-flash-preview-tts work; free daily quota ≈ 15/model.
const GEMINI_MODELS = "gemini-3.1-flash-tts-preview,gemini-2.5-flash-preview-tts";

type Provider = { kind: "google" | "gemini"; key: string; label: string; ext: "mp3" | "wav"; mime: string };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
const env = (k: string) => (Deno.env.get(k) ?? "").trim();

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64ToBytes(b64: string) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Gemini returns raw 16-bit little-endian PCM; wrap it in a WAV header so every browser can play it.
function pcmToWav(pcm: Uint8Array, rate = 24000) {
  const v = new DataView(new ArrayBuffer(44));
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + pcm.length, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(new Uint8Array(v.buffer), 0);
  out.set(pcm, 44);
  return out;
}

function pickProvider(): Provider | null {
  const all = Deno.env.toObject();
  const names = Object.keys(all).filter((k) => !/^(SUPABASE_|SB_|DENO_)/.test(k));
  const gName = ["GOOGLE_TTS_API_KEY", ...names.filter((k) => /TTS/i.test(k) && /KEY/i.test(k))].find((k) => all[k]?.trim());
  if (gName) return { kind: "google", key: all[gName].trim(), label: GOOGLE_LABEL, ext: "mp3", mime: "audio/mpeg" };
  const mName = ["GEMINI_API_KEY", ...names.filter((k) => /GEMINI|GOOGLE_API/i.test(k))].find((k) => all[k]?.trim());
  if (mName) return { kind: "gemini", key: all[mName].trim(), label: env("GEMINI_TTS_VOICE") || "Kore", ext: "wav", mime: "audio/wav" };
  return null;
}

async function googleSynth(key: string, text: string, lang: string, voices: string[]) {
  const errors: string[] = [];
  for (const name of voices) {
    const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(key)}`, {
      method: "POST",
      signal: AbortSignal.timeout(20000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: name.slice(0, 5), name },
        audioConfig: { audioEncoding: "MP3", sampleRateHertz: 24000 },
      }),
    });
    if (res.ok) return { bytes: b64ToBytes((await res.json()).audioContent), voice: name };
    errors.push(`${name}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    if (res.status === 403 || res.status === 401) break; // key/API problem: other voices will fail the same way
  }
  throw new Error(errors.join(" | "));
}

async function geminiSynth(key: string, text: string, lang: string, voice: string) {
  const prompt = lang === "en"
    ? `Read aloud in clear American English, slowly and warmly, for a 9-year-old child learning to spell: ${text}`
    : `קראי בקול בעברית ישראלית ברורה, לאט ובחום, לילדה בת 9 שלומדת לכתוב: ${text}`;
  const errors: string[] = [];
  for (const model of (env("GEMINI_TTS_MODELS") || GEMINI_MODELS).split(",").map((m) => m.trim()).filter(Boolean)) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      signal: AbortSignal.timeout(40000),
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      }),
    });
    if (!res.ok) { errors.push(`${model}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`); continue; }
    const part = ((await res.json())?.candidates?.[0]?.content?.parts ?? []).find((p: { inlineData?: unknown }) => p.inlineData);
    if (!part) { errors.push(`${model}: no audio`); continue; }
    const rate = parseInt(/rate=(\d+)/.exec(part.inlineData.mimeType ?? "")?.[1] ?? "24000", 10);
    return { bytes: pcmToWav(b64ToBytes(part.inlineData.data), rate), voice: model };
  }
  throw new Error(errors.join(" | "));
}

async function render(p: Provider, text: string, lang: string, opts: { tag?: string; voices?: string[] } = {}) {
  const tag = opts.tag ?? "";
  const path = `${tag ? `probe/${tag}/` : ""}${lang}/${await sha256(`|${p.label}|${lang}|${text}`)}.${p.ext}`;
  const base = env("SUPABASE_URL");
  const publicUrl = `${base}/storage/v1/object/public/${BUCKET}/${path}`;
  if (!tag && (await fetch(publicUrl, { method: "HEAD" })).ok) return { url: publicUrl, cached: true };

  const t0 = Date.now();
  const out = p.kind === "google"
    ? await googleSynth(p.key, text, lang, opts.voices ?? GOOGLE_VOICES[lang])
    : await geminiSynth(p.key, text, lang, p.label);
  const up = await fetch(`${base}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}`,
      "Content-Type": p.mime,
      "Cache-Control": "max-age=31536000",
      "x-upsert": "true",
    },
    body: out.bytes,
  });
  if (!up.ok) throw new Error(`upload HTTP ${up.status} ${(await up.text()).slice(0, 120)}`);
  return { url: publicUrl, cached: false, provider: p.kind, voice: out.voice, ms: Date.now() - t0, bytes: out.bytes.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const p = pickProvider();
  if (!p) return json({ error: "missing_key" }, 503);
  const body = await req.json().catch(() => ({}));
  const langOf = (l: unknown) => (l === "en" ? "en" : "he");

  if (body?.probe) {
    const lang = langOf(body.lang);
    const text = String(body.text || (lang === "en" ? "seven. There are seven days in a week. seven." : "כִּמְעַט! כּוֹתְבִים חֵית, וְלֹא כָּף. כּוֹתְבִים כָּךְ: מֵם, חֵית, בֵּית, רֵישׁ, תָּו."));
    const candidates = p.kind === "google" ? GOOGLE_VOICES[lang] : [p.label];
    const results = [];
    for (const v of candidates) {
      try {
        results.push({ voice: v, ...(await render(p, text, lang, { tag: v, voices: [v] })) });
      } catch (e) {
        results.push({ voice: v, error: String(e).slice(0, 400) });
      }
    }
    return json({ provider: p.kind, results });
  }

  if (Array.isArray(body?.warm)) {
    const deadline = Date.now() + 120_000;
    const out = [];
    let quotaHit = false;
    for (const it of body.warm.slice(0, 60)) {
      const t = String(it?.text ?? "").trim().slice(0, MAX_CHARS);
      if (!t) continue;
      if (quotaHit || Date.now() > deadline - 15_000) { out.push({ text: t, skipped: true }); continue; }
      try {
        const r = await render(p, t, langOf(it?.lang));
        out.push({ text: t, cached: r.cached, voice: (r as { voice?: string }).voice });
      } catch (e) {
        const msg = String(e);
        out.push({ text: t, error: msg.slice(0, 200) });
        if (msg.includes("429")) quotaHit = true; // quota exhausted: stop instead of spinning
      }
    }
    return json({ provider: p.kind, results: out });
  }

  const text = String(body?.text ?? "").trim().slice(0, MAX_CHARS);
  if (!text) return json({ error: "missing_text" }, 400);
  try {
    return json(await render(p, text, langOf(body?.lang)));
  } catch (e) {
    return json({ error: "tts_failed", details: String(e).slice(0, 400) }, 502);
  }
});
