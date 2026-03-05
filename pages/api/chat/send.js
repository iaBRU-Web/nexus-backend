/**
 * pages/api/chat/send.js  — AI inference
 * BUG FIX #5: Python enhance logic inlined as JS — no self-HTTP call (unreliable on Vercel)
 * All 6 models supported. Saves to GitHub DB. CORS headers for cross-repo frontend.
 */

import { authFromHeader } from "../../../lib/auth";
import { getConversation, saveConversation } from "../../../lib/github-db";
import { generateId, generateConvTitle } from "../../../lib/helpers";

// ── CORS — required because frontend is a different Vercel deployment ─────────
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

// ── Model registry ─────────────────────────────────────────────────────────────
// Only models under ~1.2B params are kept — larger models (phi-2, phi-1_5,
// qwen-1.8b, gemma-2b) all exceed Vercel Hobby's 2048 MB serverless limit.
const MODELS = {
  "tinyllama": { id:"Xenova/TinyLlama-1.1B-Chat-v1.0", label:"TinyLlama", format:"chatml" },
  "smollm2":   { id:"Xenova/SmolLM2-360M-Instruct",    label:"SmolLM2",   format:"chatml" },
};
const DEFAULT_MODEL = "tinyllama";
const pipeCache = {};

// ── Prompt builder (chatml format — used by TinyLlama & SmolLM2) ─────────────
function buildPrompt(format, history, message) {
  const sys = "You are NEXUS, a highly capable and accurate AI assistant. Give clear, well-structured, honest answers. Use Markdown where appropriate.";
  const recent = history.slice(-8);
  let p = `<|system|>\n${sys}</s>\n`;
  for (const t of recent) {
    if (t.role==="user")           p += `<|user|>\n${t.content}</s>\n<|assistant|>\n`;
    else if (t.role==="assistant") p += `${t.content}</s>\n`;
  }
  return p + `<|user|>\n${message}</s>\n<|assistant|>\n`;
}

function cleanOutput(text) {
  let out = text || "";
  out = out.replace(/<\|user\|>[\s\S]*/g,"").replace(/<\|system\|>[\s\S]*/g,"").replace(/<\/s>[\s\S]*/g,"");
  return out.trim() || "I'm not sure how to answer that. Could you rephrase?";
}

// ── BUG FIX #5: Inline enhance — no HTTP self-call ───────────────────────────
function enhanceInline(text) {
  if (!text?.trim()) return { enhanced: text, quality: 0.3, changes: [] };
  const changes = [];

  // Remove repeated sentences (Jaccard similarity)
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length > 1) {
    const kept = [];
    const seenSets = [];
    for (const s of sentences) {
      const words = new Set(s.toLowerCase().match(/\w+/g) || []);
      const isDup = seenSets.some(seen => {
        const inter = [...words].filter(w => seen.has(w)).length;
        const union = new Set([...words, ...seen]).size;
        return union > 0 && inter / union >= 0.8;
      });
      if (!isDup) { kept.push(s); seenSets.push(words); }
    }
    const deduped = kept.join(" ");
    if (deduped !== text) { text = deduped; changes.push("removed_repetition"); }
  }

  // Clean trailing whitespace and excess blank lines
  text = text.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+$/gm, "").trim();

  // Quality score
  let quality = 0.5;
  if (text.length > 100) quality += 0.1;
  if (text.length > 300) quality += 0.1;
  if (/^#{1,3}\s/m.test(text)) quality += 0.05;
  if (/^[\-\*]\s/m.test(text)) quality += 0.05;
  if (text.includes("`")) quality += 0.05;
  quality = Math.min(Math.max(Math.round(quality * 100) / 100, 0), 1);

  return { enhanced: text, quality, changes };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  const user = authFromHeader(req.headers["authorization"]);
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { message, conversationId, modelKey = DEFAULT_MODEL } = req.body ?? {};
  if (!message?.trim()) return res.status(400).json({ error: "message is required" });

  const modelDef = MODELS[modelKey] || MODELS[DEFAULT_MODEL];

  try {
    const { pipeline, env } = await import("@xenova/transformers");
    env.cacheDir = "/tmp/.cache/transformers";
    if (!pipeCache[modelKey]) {
      pipeCache[modelKey] = await pipeline("text-generation", modelDef.id);
    }
    const pipe = pipeCache[modelKey];

    const convId   = conversationId || generateId();
    const existing = await getConversation(user.username, convId);
    const messages = existing?.messages || [];

    messages.push({ id: generateId(), role:"user", content: message.trim(), timestamp: new Date().toISOString() });

    const output = await pipe(buildPrompt(modelDef.format, messages, message.trim()), {
      max_new_tokens: 150, temperature: 0.72,
      repetition_penalty: 1.15, do_sample: true, return_full_text: false,
    });

    const raw      = output[0]?.generated_text ?? "";
    const cleaned  = cleanOutput(raw);
    const enhanced = enhanceInline(cleaned);
    const aiText   = enhanced.enhanced || cleaned;

    const aiMsg = { id: generateId(), role:"assistant", content: aiText, timestamp: new Date().toISOString(), model: modelDef.label };
    messages.push(aiMsg);

    await saveConversation(user.username, {
      id: convId, title: existing?.title || generateConvTitle(message.trim()),
      messages, updatedAt: new Date().toISOString(),
      createdAt: existing?.createdAt || new Date().toISOString(), model: modelDef.label,
    });

    return res.status(200).json({ response: aiText, conversationId: convId, messageId: aiMsg.id, model: modelDef.label, quality: enhanced.quality });
  } catch (err) {
    console.error("[send]", err);
    return res.status(500).json({ error: "AI generation failed. Please try again." });
  }
}

export const config = { api: { bodyParser: { sizeLimit:"1mb" }, responseLimit: false } };
