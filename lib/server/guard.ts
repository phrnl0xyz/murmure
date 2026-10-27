import { AsyncLocalStorage } from "node:async_hooks";

// BYOK (« Bring Your Own Key ») : la personne apporte sa clé OpenAI. Elle vit dans un cookie
// HttpOnly que la page ne peut pas lire, n'est jamais enregistrée côté serveur ni écrite dans un journal.
export const BYOK_COOKIE = "murmure_byok";
const requestKey = new AsyncLocalStorage<string>();

/** Forme d'une clé OpenAI, sans dire si elle est valide. */
export const looksLikeKey = (key: string) => /^sk-[A-Za-z0-9_-]{20,300}$/.test(key);

/** Clé BYOK envoyée par le téléphone, ou null. */
export function byokKey(req: Request): string | null {
  const m = req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${BYOK_COOKIE}=([^;]+)`));
  if (!m) return null;
  let key = "";
  try { key = decodeURIComponent(m[1]); } catch {}
  return looksLikeKey(key) ? key : null;
}

/** Clé pour les appels OpenAI de la requête en cours : celle de la personne, sinon celle du serveur. */
export function currentKey(): string | undefined {
  return requestKey.getStore() ?? process.env.OPENAI_API_KEY;
}

/** Si MURMURE_CODE est défini, chaque appel doit fournir ce code. */
export function checkAccess(req: Request, given = req.headers.get("x-murmure-code")): Response | null {
  const code = process.env.MURMURE_CODE;
  if (!code) return null;
  if (given === code) return null;
  return Response.json({ error: "Code d'accès requis" }, { status: 401 });
}

/**
 * Entoure une route : une clé BYOK suffit, sinon il faut le code d'accès.
 * La clé BYOK suit tous les appels OpenAI de cette requête, et seulement de celle-là.
 */
export function guarded(handler: (req: Request) => Promise<Response>, codeOf?: (req: Request) => string | null) {
  return async (req: Request): Promise<Response> => {
    const key = byokKey(req);
    if (key) return requestKey.run(key, () => handler(req));
    const denied = checkAccess(req, codeOf ? codeOf(req) : req.headers.get("x-murmure-code"));
    return denied ?? handler(req);
  };
}

/** Retire toute clé OpenAI d'un message, même en partie masquée par OpenAI. */
export const hideKeys = (s: string) => s.replace(/sk-[A-Za-z0-9_*\-.]+/g, "sk-…");

export function errorResponse(e: unknown): Response {
  const status = typeof e === "object" && e && "status" in e && typeof e.status === "number" ? e.status : 500;
  const message = hideKeys(e instanceof Error ? e.message : String(e));
  console.error("[murmure]", message);
  return Response.json({ error: message }, { status: status >= 400 && status < 600 ? status : 500 });
}
