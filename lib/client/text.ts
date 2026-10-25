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

function numbers(s: string): string[] {
  return normalize(s).filter((w) => /\d/.test(w));
}

/**
 * Part des mots de a déjà présents dans b, de 0 à 1.
 * Si a contient un chiffre absent de b (nouveau score, nouvelle température), ce n'est jamais une répétition.
 */
export function overlap(a: string, b: string): number {
  const nb = new Set(numbers(b));
  if (numbers(a).some((n) => !nb.has(n))) return 0;
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0) return 1;
  let common = 0;
  wa.forEach((w) => {
    if (wb.has(w)) common++;
  });
  return common / wa.size;
}
