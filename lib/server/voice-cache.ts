import { randomUUID } from "node:crypto";
import { openaiFetch } from "./openai";
import { normalizeLanguage, type Language } from "../language";

// Voix préparées à l'avance : la synthèse démarre dès que la phrase est écrite, pendant la vérification.
// Quand c'est son tour, le téléphone lit ce qui est déjà reçu, puis la suite au fil de l'eau.
// Réservé au serveur local : en production, la voix reste sur un seul flux HTTP, sans cache inter-requêtes.

type Entry = { chunks: Uint8Array[]; done: boolean; failed: boolean; wake: Set<() => void>; at: number };
const cache = new Map<string, Entry>();
const TTL = 30_000;

export function voicePreparationEnabled(): boolean {
  return !process.env.VERCEL;
}

const VOICE_INSTRUCTIONS: Record<Language, string> = {
  fr: "Parle en français d'une voix douce et posée, à volume normal et bien audible, comme quelqu'un assis à côté qui glisse une info à l'oreille. Débit rapide, sans pause au début ni à la fin, ton calme et neutre d'audiodescripteur. Ne chuchote pas.",
  en: "Speak in English in a gentle, steady voice at a normal, clearly audible volume, like someone sitting nearby sharing a quick note. Speak quickly, with no pause at the beginning or end, in a calm, neutral audio-description tone. Do not whisper.",
};

export function speechBody(texte: string, language: Language = "fr") {
  return {
    model: process.env.TTS_MODEL ?? "gpt-4o-mini-tts",
    voice: process.env.TTS_VOICE ?? "marin",
    input: texte.slice(0, 300),
    instructions: VOICE_INSTRUCTIONS[normalizeLanguage(language)],
    response_format: "mp3",
  };
}

function sweep() {
  const now = Date.now();
  for (const [id, e] of cache) if (now - e.at > TTL) cache.delete(id);
}

/** Lance la synthèse tout de suite et rend un identifiant. */
export function prepareVoice(texte: string, language: Language = "fr"): string | null {
  if (!voicePreparationEnabled()) return null;
  sweep();
  const id = randomUUID();
  const e: Entry = { chunks: [], done: false, failed: false, wake: new Set(), at: Date.now() };
  cache.set(id, e);
  const ping = () => e.wake.forEach((f) => f());
  void (async () => {
    try {
      const res = await openaiFetch("/audio/speech", speechBody(texte, language));
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        e.chunks.push(value);
        ping();
      }
    } catch {
      e.failed = true;
    } finally {
      e.done = true;
      ping();
    }
  })();
  return id;
}

/** Flux de la voix préparée : ce qui est déjà reçu, puis la suite. null si l'identifiant est inconnu ou en échec. */
export function streamPrepared(id: string): ReadableStream<Uint8Array> | null {
  if (!voicePreparationEnabled()) return null;
  const e = cache.get(id);
  if (!e || (e.done && e.failed && e.chunks.length === 0)) return null;
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      for (;;) {
        if (i < e.chunks.length) {
          ctrl.enqueue(e.chunks[i++]);
          return;
        }
        if (e.done) {
          ctrl.close();
          cache.delete(id);
          return;
        }
        await new Promise<void>((r) => {
          const f = () => {
            e.wake.delete(f);
            r();
          };
          e.wake.add(f);
        });
      }
    },
  });
}
