import { checkAccess } from "@/lib/server/guard";
import { isMock } from "@/lib/server/openai";
import { prepareVoice } from "@/lib/server/voice-cache";
import { normalizeLanguage } from "@/lib/language";

// Lance la voix d'une phrase en avance et rend son identifiant, sans attendre la synthèse.
export async function POST(req: Request) {
  const denied = checkAccess(req);
  if (denied) return denied;
  const { texte, language: rawLanguage } = (await req.json().catch(() => ({}))) as { texte?: string; language?: string };
  if (!texte) return Response.json({ error: "texte manquant" }, { status: 400 });
  if (isMock() || process.env.TTS_MODE === "navigateur") return Response.json({ id: null });
  return Response.json({ id: prepareVoice(texte, normalizeLanguage(rawLanguage)) });
}
