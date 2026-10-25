import { isMock } from "@/lib/server/openai";

// Vérification au chargement de la page : le code d'accès est-il bon, la clé OpenAI est-elle là ?
// Ne renvoie jamais la valeur du code ni de la clé.
export async function POST(req: Request) {
  const expected = process.env.MURMURE_CODE;
  const given = req.headers.get("x-murmure-code") ?? "";
  const code = !expected ? "ok" : given === expected ? "ok" : given ? "wrong" : "missing";
  const openai = isMock() || Boolean(process.env.OPENAI_API_KEY);
  return Response.json({ code, openai }, { headers: { "Cache-Control": "no-store" } });
}
