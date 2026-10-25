import { checkAccess, errorResponse } from "@/lib/server/guard";
import { decisions, decisionsUnavailable, isMock, responsesJSON, SOL_MODEL } from "@/lib/server/openai";
import { VERIFY_QUESTION, VERIFY_QUESTION_EN, VERIFY_QUESTION_MONDE, VERIFY_QUESTION_MONDE_EN, type Mode } from "@/lib/server/prompts";
import { debugSave } from "@/lib/server/debug";
import type { Verification } from "@/lib/types";
import { normalizeLanguage } from "@/lib/language";

// Le vérificateur : la phrase correspond-elle exactement à l'écran ?
export async function POST(req: Request) {
  const denied = checkAccess(req);
  if (denied) return denied;
  const t0 = Date.now();
  try {
    const { image, texte, mode = "ecran", language: rawLanguage } = (await req.json()) as { image: string; texte: string; mode?: Mode; language?: string };
    const language = normalizeLanguage(rawLanguage);
    const question = mode === "monde"
      ? language === "en" ? VERIFY_QUESTION_MONDE_EN : VERIFY_QUESTION_MONDE
      : language === "en" ? VERIFY_QUESTION_EN : VERIFY_QUESTION;
    if (!image || !texte) return Response.json({ error: "image ou texte manquant" }, { status: 400 });

    if (isMock()) {
      const v: Verification = { conforme: 0.95, source: "simulation", ms: Date.now() - t0 };
      return Response.json(v);
    }

    // Vérifier la phrase réellement dite, sans transformer « à droite » en « devant ».
    const text = language === "en"
      ? mode === "monde"
        ? `Photo taken outdoors by a blind person's phone. Phrase to verify against the photo: “${texte}”`
        : `Photo of a television screen. Phrase to verify: “${texte}”`
      : mode === "monde"
        ? `Photo prise dans la rue par le téléphone d'une personne aveugle. Phrase à vérifier sur la photo : « ${texte} »`
        : `Photo d'un écran de télévision. Phrase à vérifier : « ${texte} »`;
    try {
      const a = await decisions({ text, image, questions: [question], signal: req.signal });
      const c = a.conforme;
      const v: Verification = { conforme: c?.type === "predicate" ? c.probability : 0, source: "decisions", ms: Date.now() - t0 };
      await debugSave("verif", null, { texte, ...v });
      return Response.json(v);
    } catch (e) {
      if (!decisionsUnavailable(e)) throw e;
      const r = await responsesJSON<{ conforme: number }>({
        model: SOL_MODEL(),
        instructions: `${question.instructions} ${language === "en" ? "Answer with a probability from 0 to 1." : "Réponds par une probabilité de 0 à 1."}`,
        text,
        image,
        schemaName: "verification",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { conforme: { type: "number" } },
          required: ["conforme"],
        },
        maxOutputTokens: 300,
        signal: req.signal,
      });
      const v: Verification = { conforme: r.conforme, source: "sol", ms: Date.now() - t0 };
      await debugSave("verif", null, { texte, ...v });
      return Response.json(v);
    }
  } catch (e) {
    return errorResponse(e);
  }
}
