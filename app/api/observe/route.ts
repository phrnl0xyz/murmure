import { checkAccess, errorResponse } from "@/lib/server/guard";
import { overlap } from "@/lib/client/text";
import type { Description, Observation, Verdict, Verification } from "@/lib/types";
import { POST as judge } from "../judge/route";
import { POST as describe } from "../describe/route";
import { POST as verify } from "../verify/route";

// Une seule image traverse la connexion mobile. Les étapes existantes sont appelées
// directement dans la même requête serveur, sans relais HTTP ni cache partagé.
export async function POST(req: Request) {
  const denied = checkAccess(req);
  if (denied) return denied;
  const ctrl = new AbortController();
  const cancel = () => ctrl.abort(req.signal.reason);
  req.signal.addEventListener("abort", cancel, { once: true });
  if (req.signal.aborted) cancel();
  try {
    const body = await req.json();
    if (typeof body.image !== "string" || !body.image) return Response.json({ error: "image manquante" }, { status: 400 });
    const recent: string[] = Array.isArray(body.recent) ? body.recent.filter((s: unknown) => typeof s === "string") : [];
    const input = { image: body.image, recent, mode: "monde", language: body.language };
    const headers = new Headers({ "Content-Type": "application/json" });
    const code = req.headers.get("x-murmure-code");
    if (code) headers.set("x-murmure-code", code);
    const invoke = (handler: (r: Request) => Promise<Response>, path: string, payload: unknown) => {
      if (ctrl.signal.aborted) throw ctrl.signal.reason;
      return handler(new Request(new URL(path, req.url), { method: "POST", headers, body: JSON.stringify(payload), signal: ctrl.signal }));
    };
    const judged = invoke(judge, "/api/judge", input);
    const described = invoke(describe, "/api/describe", { ...input, detail: body.detail, demoTime: body.demoTime, vitesse: body.vitesse });
    // Le conteur peut échouer pendant l'attente du juge ; son erreur reste attendue ci-dessous.
    void described.catch(() => {});
    const v = await judged;
    if (!v.ok) return v;
    const verdict = await v.json() as Verdict;
    const result: Observation = { verdict, description: null, verification: null };
    if (verdict.inutilisable >= 0.6) return Response.json(result);
    const d = await described;
    if (!d.ok) return d;
    const description = await d.json() as Description;
    result.description = description;
    if (!description.texte || description.certitude < 0.4 || recent.some(text => overlap(description.texte, text) >= 0.6)) return Response.json(result);
    const checked = await invoke(verify, "/api/verify", { image: body.image, texte: description.texte, mode: "monde", language: body.language });
    if (!checked.ok) return checked;
    result.verification = await checked.json() as Verification;
    return Response.json(result);
  } catch (e) {
    return errorResponse(e);
  } finally {
    ctrl.abort();
    req.signal.removeEventListener("abort", cancel);
  }
}
