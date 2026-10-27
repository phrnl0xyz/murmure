import { guarded } from "@/lib/server/guard";
import { debugEnabled, debugSave } from "@/lib/server/debug";

// Mode réglage : le téléphone envoie ici ce qu'il fait, pour comprendre un essai à distance.
export const POST = guarded(post);

async function post(req: Request) {
  if (!debugEnabled()) return new Response(null, { status: 204 });
  try {
    const body = (await req.json()) as { event?: string; detail?: string };
    await debugSave("telephone", null, { event: String(body.event ?? "").slice(0, 200), detail: String(body.detail ?? "").slice(0, 500) });
  } catch {}
  return new Response(null, { status: 204 });
}
