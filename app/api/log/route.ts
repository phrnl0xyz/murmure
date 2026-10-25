import { checkAccess } from "@/lib/server/guard";
import { debugSave } from "@/lib/server/debug";

// Mode réglage : le téléphone envoie ici ce qu'il fait, pour comprendre un essai à distance.
export async function POST(req: Request) {
  const denied = checkAccess(req);
  if (denied) return denied;
  try {
    const body = (await req.json()) as { event?: string; detail?: string };
    await debugSave("telephone", null, { event: String(body.event ?? "").slice(0, 200), detail: String(body.detail ?? "").slice(0, 500) });
  } catch {}
  return new Response(null, { status: 204 });
}
