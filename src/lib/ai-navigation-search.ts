export interface AuthorizedAiDestination { id: string; label: string; href: string; }

const normalize = (input: string) =>
  input.normalize("NFKC").toLocaleLowerCase("fa")
    .replace(/[ي]/g, "ی").replace(/[ك]/g, "ک")
    .replace(/[\u200c\u200f\u200e]/g, " ").trim();

/** Uses the user's own registered labels; no LLM-produced route may bypass it. */
export function findAuthorizedAiDestinations(
  candidates: readonly AuthorizedAiDestination[],
  query: string,
): AuthorizedAiDestination[] {
  const terms = normalize(query).split(/\s+/).filter((x) => x.length > 1);
  if (terms.length === 0) return [];
  return candidates.map((item) => {
    const haystack = normalize(item.label + " " + item.href.replace(/[/?&=_-]/g, " "));
    return { item, score: terms.reduce((sum, word) => sum + (haystack.includes(word) ? 1 : 0), 0) };
  }).filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8).map(({ item }) => item);
}
