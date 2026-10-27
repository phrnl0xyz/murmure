// Appels bruts à l'API OpenAI. La clé reste côté serveur.
import { currentKey } from "./guard";

const BASE = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";

export class OpenAIError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`OpenAI ${status}: ${body.slice(0, 300)}`);
  }
}

export const isMock = () => process.env.MURMURE_MOCK === "1";

export async function openaiFetch(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const key = currentKey();
  if (!key) throw new OpenAIError(500, "OPENAI_API_KEY manquante");
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new OpenAIError(res.status, await res.text());
  return res;
}

/** Vérifie une clé BYOK par un appel gratuit : true si OpenAI l'accepte, false si elle est refusée. */
export async function keyAccepted(key: string): Promise<boolean> {
  const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${key}` } });
  if (res.ok) return true;
  if (res.status === 401 || res.status === 403) return false;
  throw new OpenAIError(res.status, "Vérification de la clé impossible");
}

type ImageUrl = string; // data URL base64 ou URL https publique

/** Extrait le texte d'une réponse de la Responses API. */
function extractOutputText(data: unknown): string {
  const d = data as { output_text?: string; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> };
  if (typeof d.output_text === "string" && d.output_text) return d.output_text;
  for (const item of d.output ?? []) {
    for (const c of item.content ?? []) {
      if (c.type === "output_text" && typeof c.text === "string") return c.text;
    }
  }
  throw new OpenAIError(502, "Réponse sans texte");
}

/** Appel à la Responses API avec une image et une sortie JSON stricte. */
export async function responsesJSON<T>(opts: {
  model: string;
  instructions: string;
  text: string;
  image: ImageUrl;
  schemaName: string;
  schema: Record<string, unknown>;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** Finesse de lecture de l'image. */
  detail?: "low" | "high" | "auto";
  /** Niveau de réflexion, pour les modèles qui en ont un. */
  effort?: string;
  /** Palier de vitesse demandé par l'interface ; sinon celui de la configuration. */
  tier?: string;
}): Promise<T> {
  const body: Record<string, unknown> = {
    model: opts.model,
    instructions: opts.instructions,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: opts.text },
          { type: "input_image", image_url: opts.image, detail: opts.detail ?? "high" },
        ],
      },
    ],
    text: { format: { type: "json_schema", name: opts.schemaName, strict: true, schema: opts.schema } },
    max_output_tokens: opts.maxOutputTokens ?? 600,
  };
  if (opts.effort) body.reasoning = { effort: opts.effort };
  // Le palier « ultrafast » n'existe que pour la famille GPT-6.
  const tier = /^gpt-6/.test(opts.model) ? (opts.tier ?? process.env.SOL_SERVICE_TIER) : undefined;
  if (tier) body.service_tier = tier;
  let res: Response;
  try {
    res = await openaiFetch("/responses", body, opts.signal);
  } catch (e) {
    // Si le palier de service est refusé pour ce projet, on réessaie sans.
    // Certains modèles refusent ce palier, parfois avec un message vague : on réessaie sans.
    if (tier && e instanceof OpenAIError && e.status === 400) {
      delete body.service_tier;
      res = await openaiFetch("/responses", body, opts.signal);
    } else throw e;
  }
  return JSON.parse(extractOutputText(await res.json())) as T;
}

// ---- Decisions API (gpt-6-luna) ----

export type DecisionQuestion =
  | { type: "predicate"; name: string; instructions: string }
  | { type: "choice"; name: string; instructions: string; choices: { value: string; description: string }[] }
  | { type: "score"; name: string; instructions: string; levels: { label: string; description: string }[] };

export type DecisionAnswer =
  | { type: "predicate"; name: string; probability: number }
  | { type: "choice"; name: string; choice: string; confidence: number }
  | { type: "score"; name: string; score: number; confidence: number }
  | { type: "refusal"; name: string };

export async function decisions(opts: {
  text: string;
  image: ImageUrl;
  questions: DecisionQuestion[];
  signal?: AbortSignal;
}): Promise<Record<string, DecisionAnswer>> {
  const res = await openaiFetch(
    "/decisions",
    {
      model: process.env.DECISIONS_MODEL ?? "gpt-6-luna",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: opts.text },
            { type: "input_image", image_url: opts.image },
          ],
        },
      ],
      questions: opts.questions,
    },
    opts.signal,
  );
  const data = (await res.json()) as { answers?: DecisionAnswer[] };
  const out: Record<string, DecisionAnswer> = {};
  for (const a of data.answers ?? []) out[a.name] = a;
  return out;
}

export const SOL_MODEL = () => process.env.SOL_MODEL ?? "gpt-6.1-sol";

/** Faut-il basculer sur Sol parce que la Decisions API n'est pas accessible ? */
export function decisionsUnavailable(e: unknown): boolean {
  if (process.env.JUDGE_MODE === "sol") return true;
  // Refus d'accès, ou panne passagère du service (5xx, ex. « Decision inference is unavailable ») : plan B Sol.
  return e instanceof OpenAIError && ([401, 403, 404, 429].includes(e.status) || e.status >= 500);
}
