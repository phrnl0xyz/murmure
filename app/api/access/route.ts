import { isMock, keyAccepted } from "@/lib/server/openai";
import { debugEnabled } from "@/lib/server/debug";
import { voicePreparationEnabled } from "@/lib/server/voice-cache";
import { BYOK_COOKIE, byokKey, looksLikeKey } from "@/lib/server/guard";

// Vérification au chargement de la page : le code d'accès est-il bon, la clé OpenAI est-elle là ?
// Ne renvoie jamais la valeur du code ni de la clé.
export async function POST(req: Request) {
  const expected = process.env.MURMURE_CODE;
  const given = req.headers.get("x-murmure-code") ?? "";
  const byok = Boolean(byokKey(req));
  const code = byok || !expected ? "ok" : given === expected ? "ok" : given ? "wrong" : "missing";
  const openai = byok || isMock() || Boolean(process.env.OPENAI_API_KEY);
  return Response.json({
    code,
    openai,
    byok,
    debug: code === "ok" && debugEnabled(),
    voicePreparation: code === "ok" && voicePreparationEnabled() && !isMock() && process.env.TTS_MODE !== "navigateur",
  }, { headers: { "Cache-Control": "no-store" } });
}

// BYOK : la clé est vérifiée par un appel gratuit à OpenAI, puis rangée dans un cookie HttpOnly
// sur le téléphone. Le serveur ne la garde pas et ne l'écrit dans aucun journal.
const cookie = (req: Request, value: string, maxAge: number) =>
  `${BYOK_COOKIE}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${new URL(req.url).protocol === "https:" ? "; Secure" : ""}`;

export async function PUT(req: Request) {
  const { key = "" } = (await req.json().catch(() => ({}))) as { key?: string };
  const clean = key.trim();
  if (!looksLikeKey(clean)) return Response.json({ error: "format" }, { status: 400 });
  try {
    if (!(await keyAccepted(clean))) return Response.json({ error: "refused" }, { status: 400 });
  } catch {
    return Response.json({ error: "unreachable" }, { status: 502 });
  }
  return Response.json({ ok: true }, {
    headers: { "Set-Cookie": cookie(req, encodeURIComponent(clean), 60 * 60 * 24 * 30), "Cache-Control": "no-store" },
  });
}

export async function DELETE(req: Request) {
  return new Response(null, { status: 204, headers: { "Set-Cookie": cookie(req, "", 0) } });
}
