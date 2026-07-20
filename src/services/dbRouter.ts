// Decide which database a plain-English question is about.
//
// Policy (chosen by the operator): auto-route only when the question clearly
// names one store; otherwise return null so the bot ASKS the user. We never
// silently merge or guess between the two databases.

export type DbKey = "blacklovers" | "reseller";

// "reseller", "resellers", "reselling", "re-seller", "resell"
const RESELLER_RE = /\bre-?sell(?:er|ers|ing)?\b/i;
// "blacklovers", "black lovers", "black lover"
const BLACKLOVERS_RE = /\bblack\s?lovers?\b/i;

/**
 * Return the target database key, or null when the question is ambiguous
 * (mentions both stores, or neither) and the user should be asked.
 */
export function routeToDb(question: string): DbKey | null {
  const reseller = RESELLER_RE.test(question);
  const blacklovers = BLACKLOVERS_RE.test(question);

  // Both or neither -> unsure -> ask.
  if (reseller === blacklovers) return null;
  return reseller ? "reseller" : "blacklovers";
}
