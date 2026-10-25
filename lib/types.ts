// Types partagés entre le navigateur et le serveur.
export type Verdict = {
  teleVisible: number;
  cadrage: string;
  inutilisable: number;
  important: number;
  nature: string;
  priorite: number; // de 0 à 2
  source: "decisions" | "sol" | "simulation";
  ms: number;
};

export type Description = { texte: string; certitude: number; ms: number };
export type Verification = { conforme: number; source: Verdict["source"]; ms: number };
