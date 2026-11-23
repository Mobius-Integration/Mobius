// Law firms and referral partners (2026-11-23).
//
// Two tracks share the prospect list (prospects.track):
//   client  - we pitch our own services. Law firms are clients too, with a confidentiality line added.
//   partner - we ask a business that serves other businesses to send clients our way.
//
// Referral rewards (decided by the founder 2026-11-23, public terms on the site's /partners/ page):
//   - Lawyers: never paid for referring a client. Florida Bar guidance (Opinion 02-8 and the opinions it
//     cites) makes a lawyer who takes a referral payment tell the client in writing and pass the money on,
//     and other states treat it as a conflict consent can't cure. So the benefit goes to the referred
//     client (first month free, or the Fix Plan at no charge), and referrals run both ways with no fees.
//   - Everyone else (accountants, bookkeepers, insurance agents, print and sign shops): a flat $297
//     thank-you once a client they sent has paid its second month. First emails never state the amount.
//
// Partner drafts are fixed templates, not AI: there are no site findings to word, and a template can't
// drift into promises we haven't made.

// Overture taxonomy ids (taxonomy.primary) for law firms pitched as clients: practices whose own clients
// are mostly people, so the firm itself is the customer.
export const LAW_CLIENT_KINDS = new Set([
  "attorney_or_law_firm", "personal_injury_law", "divorce_and_family_law", "criminal_defense_law", "bankruptcy_law",
  "immigration_law", "wills_trusts_and_probate", "estate_planning_law", "employment_law", "disability_law",
  "social_security_law", "dui_law", "workers_compensation_law", "medical_law", "general_litigation",
  "tenant_and_eviction_law", "civil_rights_lawyer",
]);

// Partner kinds: group decides the draft; priority orders the partner picks (1 first).
export const PARTNER_KINDS = {
  business_law: { group: "lawyer", label: "Business law firm", priority: 1 },
  real_estate_law: { group: "lawyer", label: "Real estate law firm", priority: 1 },
  contract_law: { group: "lawyer", label: "Contract law firm", priority: 1 },
  tax_law: { group: "lawyer", label: "Tax law firm", priority: 1 },
  ip_and_internet_law: { group: "lawyer", label: "IP and internet law firm", priority: 1 },
  patent_law: { group: "lawyer", label: "Patent law firm", priority: 1 },
  accountant: { group: "accounting", label: "Accountant", priority: 2 },
  bookkeeper: { group: "accounting", label: "Bookkeeper", priority: 2 },
  payroll_service: { group: "accounting", label: "Payroll service", priority: 2 },
  tax_service: { group: "accounting", label: "Tax preparer", priority: 3 },
  insurance_agency: { group: "insurance", label: "Insurance agency", priority: 3 },
  auto_insurance: { group: "insurance", label: "Insurance agency", priority: 4 },
  life_insurance: { group: "insurance", label: "Insurance agency", priority: 4 },
  home_and_rental_insurance: { group: "insurance", label: "Insurance agency", priority: 4 },
  commercial_printer: { group: "print", label: "Commercial printer", priority: 3 },
  printing_service: { group: "print", label: "Print shop", priority: 3 },
  sign_making: { group: "print", label: "Sign shop", priority: 3 },
  b2b_signage_service: { group: "print", label: "Sign shop", priority: 3 },
};

const LAW_KIND_LABELS = {
  attorney_or_law_firm: "Law firm", personal_injury_law: "Personal injury law firm", divorce_and_family_law: "Family law firm",
  criminal_defense_law: "Criminal defense firm", bankruptcy_law: "Bankruptcy law firm", immigration_law: "Immigration law firm",
  wills_trusts_and_probate: "Wills and probate firm", estate_planning_law: "Estate planning firm", employment_law: "Employment law firm",
  disability_law: "Disability law firm", social_security_law: "Social Security law firm", dui_law: "DUI defense firm",
  workers_compensation_law: "Workers' comp law firm", medical_law: "Medical law firm", general_litigation: "Litigation firm",
  tenant_and_eviction_law: "Landlord-tenant law firm", civil_rights_lawyer: "Civil rights law firm", legal_service: "Law firm",
};

// "Partner priority" as SQL, for ORDER BY in the partner picks (kept in step with PARTNER_KINDS).
export const PARTNER_PRIORITY_SQL = `CASE p.kind ${Object.entries(PARTNER_KINDS).map(([k, v]) => `WHEN '${k}' THEN ${v.priority}`).join(" ")} ELSE 9 END`;

export function kindLabel(kind) {
  return (PARTNER_KINDS[kind] && PARTNER_KINDS[kind].label) || LAW_KIND_LABELS[kind] || null;
}

const LAWISH_NAME = /\b(law|lawyers?|attorneys?|legal|esq\.?|counsel|p\.?\s?a\.?|pllc|llp)\b/i;

// A law firm on the client track: an Overture law kind, or an older OpenStreetMap "professional" office
// whose name says law firm.
export function isLawFirm(p) {
  if (!p || p.track === "partner") return false;
  if (p.kind && (LAW_CLIENT_KINDS.has(p.kind) || p.kind === "legal_service")) return true;
  return p.category === "professional" && !p.kind && /\b(law|lawyers?|attorneys?|legal|esq\.?|injury)\b/i.test(String(p.name || ""));
}

// Overture's generic "legal_service" also covers notaries, document preparers and process servers, so a
// place there counts as a law firm only when its name says so.
export function lawishName(name) {
  return LAWISH_NAME.test(String(name || ""));
}

// Inserted by code into law-firm client drafts, before the closing question.
export const LAW_LINE = "Since your firm handles client confidences, I'm glad to sign a confidentiality agreement before touching anything beyond your public site.";

export function partnerGroup(p) {
  return (p && PARTNER_KINDS[p.kind] && PARTNER_KINDS[p.kind].group) || null;
}

const INTRO = "I'm Mario, founder of Mobius Integration, a Tampa Bay tech partner for local businesses: websites, online booking, email and the everyday tech in between.";
const CLOSE = "Would a 15-minute coffee or call be worth it?";

const GROUP_COPY = {
  accounting: {
    ask: (name) => `Your business clients probably ask you about more than their books. When a client of ${name} asks who can sort out their website or tech, I'd like to be the name you give them.`,
    back: "help with their books or taxes",
  },
  insurance: {
    ask: (name) => `Business owners lean on their agent's advice. When a client of ${name} mentions their website or tech is a headache, I'd like to be the name you give them.`,
    back: "insurance",
  },
  print: {
    ask: (name) => `When a customer of ${name} orders new signs or print, their website often needs to catch up. When it does, I'd like to be the name you give them.`,
    back: "signs or printing",
  },
};

// The partner email, as { subject, body, model, angle }. The body stops before the signature and the
// compliance line, which digest.js adds to every draft.
export function partnerDraft(p) {
  const name = String(p.name || "your firm").trim();
  const group = partnerGroup(p);
  if (group === "lawyer") {
    return {
      subject: `A tech contact for ${name}'s clients`,
      body: [
        "Hi there,",
        INTRO,
        `Business owners tend to ask their lawyer who to trust, tech included. If a client of ${name} ever needs a website fixed, made usable with a screen reader, or just a reliable person to call, I'd like to be a name you can give them.`,
        "Clients you send get their first month free. There are no referral fees either way, and I'm glad to point my clients to you when they need a lawyer.",
        CLOSE,
      ].join("\n\n"),
      model: "partner-template",
      angle: "partner-lawyer",
    };
  }
  const copy = GROUP_COPY[group] || GROUP_COPY.accounting;
  return {
    subject: `A tech contact for ${name}'s clients`,
    body: [
      "Hi there,",
      INTRO,
      copy.ask(name),
      `I pay a flat thank-you for every client you send who signs on, and I'm glad to send my clients your way when they need ${copy.back}.`,
      CLOSE,
    ].join("\n\n"),
    model: "partner-template",
    angle: `partner-${group || "accounting"}`,
  };
}
