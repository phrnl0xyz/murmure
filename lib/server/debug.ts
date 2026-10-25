import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Mode réglage (MURMURE_DEBUG=1) : garde sur le Mac l'image vue par le juge et sa réponse,
// pour comprendre un test raté. Le dossier debug/ n'est jamais publié.
export function debugEnabled(): boolean {
  return process.env.MURMURE_DEBUG === "1" && !process.env.VERCEL;
}

export async function debugSave(kind: string, image: string | null, data: unknown): Promise<void> {
  // Sur Vercel, le disque est en lecture seule : le mode réglage ne sert qu'en local.
  if (!debugEnabled()) return;
  try {
    const dir = path.join(process.cwd(), "debug");
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let file: string | null = null;
    const m = image?.match(/^data:image\/jpeg;base64,(.+)$/);
    if (m) {
      file = `${stamp}-${kind}.jpg`;
      await writeFile(path.join(dir, file), Buffer.from(m[1], "base64"));
    }
    await appendFile(path.join(dir, "journal.jsonl"), JSON.stringify({ t: stamp, kind, file, data }) + "\n");
  } catch {}
}
