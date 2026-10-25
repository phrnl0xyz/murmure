// Filtre déterministe anti-répétition.
function normalize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function words(s: string): Set<string> {
  return new Set(normalize(s).filter((w) => w.length > 2 || /\d/.test(w)));
}

const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", un: "1", une: "1", two: "2", deux: "2", three: "3", trois: "3",
  four: "4", quatre: "4", five: "5", cinq: "5", six: "6", seven: "7", sept: "7", eight: "8", huit: "8",
  nine: "9", neuf: "9", ten: "10", dix: "10", eleven: "11", onze: "11", twelve: "12", douze: "12",
  thirteen: "13", treize: "13", fourteen: "14", quatorze: "14", fifteen: "15", quinze: "15",
  sixteen: "16", seize: "16", seventeen: "17", eighteen: "18", nineteen: "19",
  twenty: "20", vingt: "20", vingts: "20", thirty: "30", trente: "30", forty: "40", quarante: "40",
  fifty: "50", cinquante: "50", sixty: "60", soixante: "60", seventy: "70", eighty: "80", ninety: "90",
  hundred: "100", cent: "100", cents: "100", thousand: "1000", mille: "1000",
};
const DIRECTIONS = new Set(["gauche", "droite", "devant", "derriere", "haut", "bas", "left", "right", "ahead", "behind"]);
const NEGATIONS = new Set(["ne", "n", "pas", "jamais", "aucun", "aucune", "sans", "non", "no", "not", "never", "without", "cannot", "isn", "doesn", "don"]);
const COLORS = new Map([
  ["bleu", "bleu"], ["bleus", "bleu"], ["blue", "bleu"], ["rouge", "rouge"], ["rouges", "rouge"], ["red", "rouge"],
  ["rose", "rose"], ["roses", "rose"], ["pink", "rose"], ["vert", "vert"], ["verts", "vert"], ["green", "vert"],
  ["jaune", "jaune"], ["jaunes", "jaune"], ["yellow", "jaune"], ["blanc", "blanc"], ["blancs", "blanc"], ["white", "blanc"],
  ["noir", "noir"], ["noirs", "noir"], ["black", "noir"],
]);
const ACTIONS: [RegExp, string][] = [
  [/^(frapp|tir|shoot|shot)/, "tir"], [/^(marqu|scor|but$|goal$)/, "but"],
  [/^(arret|bloqu|sav)/, "arret"], [/^(rat|manqu|miss)/, "rate"],
  [/^(pass|centr|cross)/, "passe"], [/^(perd|loses|lost)/, "perte"],
  [/^(recuper|regain|wins)/, "recupere"], [/^(attaqu|attack)/, "attaque"],
];

function numbers(tokens: string[]): string[] {
  return tokens.flatMap((w, i) => {
    if (/\d/.test(w)) return [w];
    // « un joueur » est un article ; « un partout » est bien un nombre.
    if ((w === "un" || w === "une") && !["partout", "euro", "euros", "point", "points", "but", "buts"].includes(tokens[i + 1])) return [];
    return Object.hasOwn(NUMBER_WORDS, w) ? [NUMBER_WORDS[w]] : [];
  });
}

function names(s: string): string[] {
  const tokens = s.match(/[\p{L}\p{N}]+/gu) ?? [];
  const openings = new Set(["le", "la", "les", "un", "une", "des", "the", "a", "an", "carte", "score", "bus", "panneau", "affiche", "bandeau", "football", "but"]);
  return tokens.filter((w, i) => /^[A-ZÀ-Ý]/.test(w) && (i > 0 || !openings.has(w.toLowerCase())))
    .flatMap((w) => normalize(w).filter((x) => x.length > 2 && !Object.hasOwn(NUMBER_WORDS, x) && !DIRECTIONS.has(x)));
}

function changedFacts(a: string, b: string): boolean {
  const ta = normalize(a), tb = normalize(b);
  const different = (x: string[], y: string[]) => x.length > 0 && x.join("|") !== y.join("|");
  if (different(numbers(ta), numbers(tb))) return true;
  if (different(ta.filter(x => DIRECTIONS.has(x)), tb.filter(x => DIRECTIONS.has(x)))) return true;
  if (ta.some(x => NEGATIONS.has(x)) !== tb.some(x => NEGATIONS.has(x))) return true;
  const colors = (tokens: string[]) => tokens.flatMap(x => COLORS.has(x) ? [COLORS.get(x)!] : []);
  if (different(colors(ta), colors(tb))) return true;
  const actions = (tokens: string[]) => tokens.flatMap(w => {
    const action = ACTIONS.find(([pattern]) => pattern.test(w));
    return action ? [action[1]] : [];
  });
  const uniqueActions = (tokens: string[]) => actions(tokens).filter((value, i, all) => i === 0 || value !== all[i - 1]);
  if (different(uniqueActions(ta), uniqueActions(tb))) return true;
  const previousNames = new Set(names(b));
  return names(a).some(x => !previousNames.has(x));
}

/**
 * Part des mots de a déjà présents dans b, de 0 à 1.
 * Un score, une direction, un nom ou une action différents passent avant la ressemblance des mots.
 */
export function overlap(a: string, b: string): number {
  if (changedFacts(a, b)) return 0;
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0) return 1;
  let common = 0;
  wa.forEach((w) => {
    if (wb.has(w)) common++;
  });
  return common / wa.size;
}
