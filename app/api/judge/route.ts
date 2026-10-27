import { guarded, errorResponse } from "@/lib/server/guard";
import { decisions, decisionsUnavailable, isMock, responsesJSON, SOL_MODEL } from "@/lib/server/openai";
import { contextText, JUDGE_FALLBACK_SCHEMA, judgeFallbackInstructions, judgeQuestions, type Mode } from "@/lib/server/prompts";
import type { Verdict } from "@/lib/types";
import { debugSave } from "@/lib/server/debug";
import { normalizeLanguage } from "@/lib/language";

// Le juge : faut-il parler, et la télé est-elle bien cadrée ?
export const POST = guarded(post);

async function post(req: Request) {
  const t0 = Date.now();
  try {
    const { image, recent = [], mode = "ecran", language: rawLanguage } = (await req.json()) as { image: string; recent?: string[]; mode?: Mode; language?: string };
    const language = normalizeLanguage(rawLanguage);
    const monde = mode === "monde"; // dans la rue, pas d'écran à chercher
    if (!image) return Response.json({ error: "image manquante" }, { status: 400 });

    if (isMock()) {
      const v: Verdict = { teleVisible: 0.95, cadrage: "bon", inutilisable: 0.05, important: 0.9, nature: "bandeau_ou_texte", priorite: 0.6, source: "simulation", ms: 0 };
      return Response.json({ ...v, ms: Date.now() - t0 });
    }

    try {
      const a = await decisions({ text: contextText(recent, mode, language), image, questions: judgeQuestions(mode, language), signal: req.signal });
      const p = (n: string) => (a[n]?.type === "predicate" ? a[n].probability : 0);
      const cadrage = monde ? "bon" : a.cadrage?.type === "choice" ? a.cadrage.choice : "pas_de_tele";
      const nature = a.nature?.type === "choice" ? a.nature.choice : "rien";
      const priorite = a.priorite?.type === "score" ? a.priorite.score : 0;
      const v: Verdict = {
        teleVisible: monde ? 1 : p("tele_visible"),
        cadrage,
        inutilisable: p("image_inutilisable"),
        important: p("changement_important"),
        nature,
        priorite,
        source: "decisions",
        ms: Date.now() - t0,
      };
      await debugSave("juge", image, v);
      return Response.json(v);
    } catch (e) {
      if (!decisionsUnavailable(e)) throw e;
      // Plan B : Sol répond aux mêmes questions en JSON strict.
      const r = await responsesJSON<{
        tele_visible: number; cadrage: string; image_inutilisable: number; changement_important: number; nature: string; priorite: number;
      }>({
        model: SOL_MODEL(),
        instructions: judgeFallbackInstructions(mode, language),
        text: contextText(recent, mode, language),
        image,
        schemaName: "verdict",
        schema: JUDGE_FALLBACK_SCHEMA,
        signal: req.signal,
      });
      const v: Verdict = {
        teleVisible: monde ? 1 : r.tele_visible,
        cadrage: monde ? "bon" : r.cadrage,
        inutilisable: r.image_inutilisable,
        important: r.changement_important,
        nature: r.nature,
        priorite: r.priorite,
        source: "sol",
        ms: Date.now() - t0,
      };
      await debugSave("juge", image, v);
      return Response.json(v);
    }
  } catch (e) {
    return errorResponse(e);
  }
}
