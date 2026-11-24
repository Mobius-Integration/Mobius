// How a business's name reads in an email: Overture title-cases legal suffixes ("Amy G. Cohen, P.a."),
// and a name ending in "s" takes a bare apostrophe ("Associates Attorneys’ clients", not "Attorneys's").

export function displayName(name) {
  return String(name || "").replace(/\s+/g, " ").trim()
    .replace(/\b(p\.?\s?a|p\.?\s?l|p\.?\s?l\.?\s?l\.?\s?c|l\.?\s?l\.?\s?c|l\.?\s?l\.?\s?p|p\.?\s?c)\.?$/i, (m) => m.toUpperCase());
}

// "Smith Dental’s", "Associates Attorneys’", "Jones, P.A.’s".
export function possessive(name) {
  const n = displayName(name);
  return /s$/i.test(n) ? `${n}’` : `${n}’s`;
}
