// dictation-tts: turns a short text into natural speech with Gemini TTS and caches it.
// POST { text, lang?: "he" | "en" }        → 200 { url, cached }   (public WAV in Storage bucket "tts")
// POST { probe: true, text?, models? }      → lists TTS models for the key and test-renders `text`
// POST { warm: [{ text, lang }] }           → pre-renders up to 60 clips (used to fill the fixed-phrase cache)
// Secrets: GEMINI_API_KEY. Optional: GEMINI_TTS_MODELS (comma-separated), GEMINI_TTS_VOICE.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const BUCKET = "tts";
// Probed 2026-11-11 on the free key: 3.1-flash-tts-preview ~11 s and 2.5-flash-preview-tts ~13 s for a long
// sentence; 3.8-flash-tts timed out at 40 s.
const DEFAULT_MODELS = "gemini-3.1-flash-tts-preview,gemini-2.5-flash-preview-tts";
const MAX_CHARS = 400;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });

const env = (k: string) => (Deno.env.get(k) ?? "").trim();

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Gemini returns raw 16-bit little-endian PCM; wrap it in a WAV header so every browser can play it.
function pcmToWav(pcm: Uint8Array, rate = 24000, channels = 1, bits = 16) {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + pcm.length, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, rate, true); v.setUint32(28, (rate * channels * bits) / 8, true);
  v.setUint16(32, (channels * bits) / 8, true); v.setUint16(34, bits, true);
  w(36, "data"); v.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}

function b64ToBytes(b64: string) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function stylePrompt(text: string, lang: string) {
  return lang === "en"
    ? `Read aloud in clear American English, slowly and warmly, for a 9-year-old child learning to spell: ${text}`
    : `קראי בקול בעברית ישראלית ברורה, לאט ובחום, לילדה בת 9 שלומדת לכתוב: ${text}`;
}

async function synth(model: string, key: string, text: string, lang: string, voice: string) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    signal: AbortSignal.timeout(40000),
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: stylePrompt(text, lang) }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    }),
  });
  if (!res.ok) throw new Error(`${model}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  const part = (data?.candidates?.[0]?.content?.parts ?? []).find((p: { inlineData?: unknown }) => p.inlineData);
  if (!part) throw new Error(`${model}: no audio in response`);
  const mime: string = part.inlineData.mimeType ?? "";
  const rate = parseInt(/rate=(\d+)/.exec(mime)?.[1] ?? "24000", 10);
  return pcmToWav(b64ToBytes(part.inlineData.data), rate);
}

function storageUrls(path: string) {
  const base = env("SUPABASE_URL");
  return { publicUrl: `${base}/storage/v1/object/public/${BUCKET}/${path}`, uploadUrl: `${base}/storage/v1/object/${BUCKET}/${path}` };
}

async function render(text: string, lang: string, models: string[], key: string, voice: string, tag = "") {
  const path = `${tag ? "probe/" : ""}${lang}/${await sha256(`${tag}|${voice}|${lang}|${text}`)}.wav`;
  const { publicUrl, uploadUrl } = storageUrls(path);
  const head = await fetch(publicUrl, { method: "HEAD" });
  if (head.ok) return { url: publicUrl, cached: true };

  const errors: string[] = [];
  for (const model of models) {
    try {
      const t0 = Date.now();
      const wav = await synth(model, key, text, lang, voice);
      const up = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}`,
          "Content-Type": "audio/wav",
          "Cache-Control": "max-age=31536000",
          "x-upsert": "true",
        },
        body: wav,
      });
      if (!up.ok) throw new Error(`upload HTTP ${up.status} ${(await up.text()).slice(0, 120)}`);
      return { url: publicUrl, cached: false, model, ms: Date.now() - t0, bytes: wav.length };
    } catch (e) {
      errors.push(String(e));
    }
  }
  throw new Error(errors.join(" | "));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // Same lookup as dictation-words: prefer GEMINI_API_KEY, else any secret whose name mentions GEMINI / GOOGLE_API.
  const all = Deno.env.toObject();
  const custom = Object.keys(all).filter((k) => !k.startsWith("SUPABASE_") && !k.startsWith("SB_") && !k.startsWith("DENO_"));
  const keyName = ["GEMINI_API_KEY", ...custom.filter((k) => /GEMINI|GOOGLE_API/i.test(k))].find((k) => all[k]);
  const key = keyName ? all[keyName].trim() : "";
  if (!key) return json({ error: "missing_key", secret_names: custom.filter((k) => /KEY|API|GEMINI|GOOGLE/i.test(k)) }, 503);
  const voice = env("GEMINI_TTS_VOICE") || "Kore";
  const body = await req.json().catch(() => ({}));
  const models: string[] = Array.isArray(body?.models) && body.models.length
    ? body.models.slice(0, 4).map(String)
    : (env("GEMINI_TTS_MODELS") || DEFAULT_MODELS).split(",").map((m) => m.trim()).filter(Boolean);

  if (body?.probe) {
    const list = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=300", { headers: { "x-goog-api-key": key } })
      .then((r) => r.json()).catch((e) => ({ error: String(e) }));
    const tts = (list?.models ?? []).map((m: { name: string }) => m.name.replace("models/", "")).filter((n: string) => /tts/i.test(n));
    const tryModels = Array.isArray(body?.models) && body.models.length ? models : tts.slice(0, 3);
    const results = [];
    for (const m of tryModels) {
      try {
        results.push({ model: m, ...(await render(String(body.text || "עַיִן. כותבים עַיִן, כמו בעֵץ."), body.lang === "en" ? "en" : "he", [m], key, String(body.voice || voice), m)) });
      } catch (e) {
        results.push({ model: m, error: String(e).slice(0, 220) });
      }
    }
    return json({ tts_models: tts, results });
  }

  // Batch pre-render: { warm: [{ text, lang }] } renders sequentially within a time budget.
  if (Array.isArray(body?.warm)) {
    const deadline = Date.now() + 120_000;
    const out = [];
    for (const it of body.warm.slice(0, 60)) {
      const t = String(it?.text ?? "").trim().slice(0, MAX_CHARS);
      const l = it?.lang === "en" ? "en" : "he";
      if (!t) continue;
      // The free tier is limited per minute (HTTP 429): back off and retry until the time budget runs out.
      let done = false;
      while (!done) {
        if (Date.now() > deadline - 20_000) { out.push({ text: t, skipped: true }); break; }
        try {
          const r = await render(t, l, models, key, voice);
          out.push({ text: t, cached: r.cached, model: (r as { model?: string }).model });
          done = true;
        } catch (e) {
          const msg = String(e);
          if (!msg.includes("429")) { out.push({ text: t, error: msg.slice(0, 160) }); break; }
          await new Promise((r) => setTimeout(r, 15_000));
        }
      }
    }
    return json({ results: out });
  }

  const text = String(body?.text ?? "").trim().slice(0, MAX_CHARS);
  if (!text) return json({ error: "missing_text" }, 400);
  const lang = body?.lang === "en" ? "en" : "he";
  try {
    return json(await render(text, lang, models, key, voice));
  } catch (e) {
    return json({ error: "tts_failed", details: String(e).slice(0, 400) }, 502);
  }
});
