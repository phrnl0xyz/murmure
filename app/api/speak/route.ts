import { guarded, errorResponse } from "@/lib/server/guard";
import { isMock, openaiFetch } from "@/lib/server/openai";
import { debugSave } from "@/lib/server/debug";
import { speechBody, streamPrepared } from "@/lib/server/voice-cache";
import { normalizeLanguage } from "@/lib/language";

// La voix : synthèse vocale OpenAI, renvoyée en flux pour que le téléphone commence à parler
// dès les premiers sons, sans attendre la phrase entière.

async function voice(texte: string, signal: AbortSignal, language: "fr" | "en"): Promise<Response> {
  if (!texte) return Response.json({ error: "texte manquant" }, { status: 400 });
  if (isMock() || process.env.TTS_MODE === "navigateur") return new Response(null, { status: 204 });
  const res = await openaiFetch("/audio/speech", speechBody(texte, language), signal);
  await debugSave("voix", null, { texte });
  return new Response(res.body, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "X-Murmure-Voice": "direct" } });
}

// POST : le téléphone reçoit le fichier entier (chemin de secours).
export const POST = guarded(post);

async function post(req: Request) {
  try {
    const { texte, language: rawLanguage } = (await req.json()) as { texte: string; language?: string };
    return await voice(texte, req.signal, normalizeLanguage(rawLanguage));
  } catch (e) {
    return errorResponse(e);
  }
}

// GET : lu directement par l'élément <audio>, qui joue le son au fur et à mesure qu'il arrive.
// Un élément <audio> ne peut pas envoyer d'en-tête : le code d'accès passe dans l'adresse.
// La clé BYOK, elle, n'y passe jamais : elle arrive par son cookie.
export const GET = guarded(get, (req) => new URL(req.url).searchParams.get("k"));

async function get(req: Request) {
  const url = new URL(req.url);
  try {
    const language = normalizeLanguage(url.searchParams.get("language"));
    // Voix préparée pendant la vérification : on sert ce qui est déjà prêt, puis la suite.
    const id = url.searchParams.get("id");
    const prepared = id ? streamPrepared(id) : null;
    if (prepared) {
      await debugSave("voix", null, { texte: url.searchParams.get("t") ?? "", preparee: true });
      return new Response(prepared, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "X-Murmure-Voice": "prepared" } });
    }
    return await voice(url.searchParams.get("t") ?? "", req.signal, language);
  } catch (e) {
    return errorResponse(e);
  }
}
