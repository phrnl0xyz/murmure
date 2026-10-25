/** Si MURMURE_CODE est défini, chaque appel doit fournir ce code. */
export function checkAccess(req: Request): Response | null {
  const code = process.env.MURMURE_CODE;
  if (!code) return null;
  if (req.headers.get("x-murmure-code") === code) return null;
  return Response.json({ error: "Code d'accès requis" }, { status: 401 });
}

export function errorResponse(e: unknown): Response {
  const status = typeof e === "object" && e && "status" in e && typeof e.status === "number" ? e.status : 500;
  const message = e instanceof Error ? e.message : String(e);
  console.error("[murmure]", message);
  return Response.json({ error: message }, { status: status >= 400 && status < 600 ? status : 500 });
}
