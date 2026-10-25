import { checkAccess, errorResponse } from "@/lib/server/guard";
import { isMock, responsesJSON, SOL_MODEL } from "@/lib/server/openai";
import { DESCRIBE_SCHEMA, describeInstructions, type Mode } from "@/lib/server/prompts";
import type { Description } from "@/lib/types";
import { debugSave } from "@/lib/server/debug";
import { normalizeLanguage, type Language } from "@/lib/language";

let mockCount = 0;

// Simulation sans clé : pour la vidéo de test, on lit le script de la vidéo (un écran toutes les 10 s).
const DEMO_SCRIPT: Record<Language, string[]> = {
  fr: [
  "Carte météo. Haute-Corse en vigilance rouge.",
  "Flash info : routes coupées en Corse-du-Sud.",
  "Football. PSG 2, OM 1.",
  "À l'écran : Marie Dupont, maire de Bastia.",
  ],
  en: [
    "Weather map. Haute-Corse is under a red alert.",
    "Breaking news: roads closed in Corse-du-Sud.",
    "Football. PSG 2, OM 1.",
    "On screen: Marie Dupont, mayor of Bastia.",
  ],
};

// Le conteur : GPT-6.1 Sol écrit la phrase à chuchoter.
export async function POST(req: Request) {
  const denied = checkAccess(req);
  if (denied) return denied;
  const t0 = Date.now();
  try {
    const { image, recent = [], detail = "sobre", demoTime, bench, mode = "ecran", vitesse, language: rawLanguage } = (await req.json()) as {
      image: string; recent?: string[]; detail?: "sobre" | "detaille"; demoTime?: number; mode?: Mode;
      bench?: { model?: string; effort?: string; detail?: "low" | "high" | "auto" };
      vitesse?: "eco" | "rapide";
      language?: string;
    };
    const language = normalizeLanguage(rawLanguage);
    // Banc d'essai : réglages imposés, seulement en mode réglage.
    const b = process.env.MURMURE_DEBUG === "1" ? bench : undefined;
    if (!image) return Response.json({ error: "image manquante" }, { status: 400 });

    if (isMock()) {
      mockCount += 1;
      const texte =
        typeof demoTime === "number"
          ? DEMO_SCRIPT[language][Math.floor(demoTime / 10) % DEMO_SCRIPT[language].length]
          : language === "en" ? `Sample phrase ${mockCount}.` : `Phrase d'essai numéro ${mockCount}.`;
      const d: Description = { texte, certitude: 0.9, ms: Date.now() - t0 };
      return Response.json(d);
    }

    const r = await responsesJSON<{ texte: string; certitude: number }>({
      model: b?.model ?? SOL_MODEL(),
      effort: b ? b.effort : (process.env.SOL_EFFORT ?? "low"), // mesuré au banc : plus rapide et plus juste
      // Réglage de l'interface : « rapide » = palier ultrafast (prix x6), « eco » = palier fast (prix x2).
      tier: vitesse === "rapide" ? "ultrafast" : vitesse === "eco" ? "fast" : undefined,
      detail: b?.detail ?? ((process.env.SOL_IMAGE_DETAIL as "low" | "high" | "auto" | undefined) ?? "high"),
      instructions: describeInstructions(detail, recent, mode, language),
      text: language === "en" ? "What should be whispered now?" : "Que faut-il chuchoter maintenant ?",
      image,
      schemaName: "description",
      schema: DESCRIBE_SCHEMA,
      maxOutputTokens: 600, // inclut la réflexion du modèle : trop bas, la réponse est coupée
      signal: req.signal,
    });
    const d: Description = { texte: r.texte.trim(), certitude: r.certitude, ms: Date.now() - t0 };
    if (!b) await debugSave("conteur", null, { ...d, vitesse: vitesse ?? "configuration" });
    return Response.json(d);
  } catch (e) {
    return errorResponse(e);
  }
}
