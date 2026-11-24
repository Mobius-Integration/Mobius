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

import { displayName, possessive } from "./names.js";

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

// Owner-run local businesses that book appointments or jobs (imported 2026-11-24 with
// `scripts/overture-local.mjs --set local`): the best fit for a $297/month tech partner. `category` is the
// audience id the score, the booking finding and the drafts use; `label` is what the board and drafts call
// them. All are clients.
export const LOCAL_KINDS = {
  dental_clinic: { category: "dental-medical", label: "Dental office" },
  general_dentistry: { category: "dental-medical", label: "Dental office" },
  cosmetic_dentistry: { category: "dental-medical", label: "Cosmetic dentist" },
  pediatric_dentistry: { category: "dental-medical", label: "Pediatric dentist" },
  orthodontics: { category: "dental-medical", label: "Orthodontist" },
  chiropractic: { category: "dental-medical", label: "Chiropractor" },
  physical_therapy: { category: "dental-medical", label: "Physical therapy practice" },
  optometry: { category: "dental-medical", label: "Optometrist" },
  vision_or_eye_care_clinic: { category: "dental-medical", label: "Eye care clinic" },
  dermatology: { category: "dental-medical", label: "Dermatology practice" },
  veterinarian: { category: "dental-medical", label: "Veterinary clinic" },
  hearing_aid_store: { category: "dental-medical", label: "Hearing care clinic" },
  medical_spa: { category: "medspa-salon", label: "Med spa" },
  spa: { category: "medspa-salon", label: "Spa" },
  day_spa: { category: "medspa-salon", label: "Day spa" },
  massage_therapy: { category: "medspa-salon", label: "Massage studio" },
  hair_salon: { category: "medspa-salon", label: "Hair salon" },
  beauty_salon: { category: "medspa-salon", label: "Beauty salon" },
  nail_salon: { category: "medspa-salon", label: "Nail salon" },
  barber: { category: "medspa-salon", label: "Barbershop" },
  tattoo_and_piercing: { category: "medspa-salon", label: "Tattoo studio" },
  pet_groomer: { category: "medspa-salon", label: "Pet groomer" },
  gym: { category: "fitness", label: "Gym" },
  yoga_studio: { category: "fitness", label: "Yoga studio" },
  pilates_studio: { category: "fitness", label: "Pilates studio" },
  martial_arts_club: { category: "fitness", label: "Martial arts school" },
  dance_studio: { category: "fitness", label: "Dance studio" },
  fitness_trainer: { category: "fitness", label: "Personal training studio" },
  hvac_service: { category: "home-services", label: "HVAC company" },
  plumbing: { category: "home-services", label: "Plumbing company" },
  electrician: { category: "home-services", label: "Electrician" },
  roofing: { category: "home-services", label: "Roofing company" },
  pest_control_service: { category: "home-services", label: "Pest control company" },
  landscaping: { category: "home-services", label: "Landscaping company" },
  lawn_service: { category: "home-services", label: "Lawn care company" },
  home_cleaning: { category: "home-services", label: "Home cleaning company" },
  cleaning_service: { category: "home-services", label: "Cleaning company" },
  carpet_cleaning: { category: "home-services", label: "Carpet cleaning company" },
  pool_and_hot_tub_service: { category: "home-services", label: "Pool service" },
  pool_cleaning: { category: "home-services", label: "Pool service" },
  painting: { category: "home-services", label: "Painting company" },
  garage_door_service: { category: "home-services", label: "Garage door company" },
  handyman: { category: "home-services", label: "Handyman service" },
  flooring_contractor: { category: "home-services", label: "Flooring company" },
  windows_installation: { category: "home-services", label: "Window company" },
  automotive_repair: { category: "home-services", label: "Auto repair shop" },
  auto_body_shop: { category: "home-services", label: "Auto body shop" },
  automotive_service: { category: "home-services", label: "Auto service shop" },
  auto_detailing: { category: "home-services", label: "Auto detailing shop" },
  tire_shop: { category: "home-services", label: "Tire shop" },
  tire_dealer_and_repair: { category: "home-services", label: "Tire shop" },
  auto_glass_service: { category: "home-services", label: "Auto glass shop" },
  car_window_tinting: { category: "home-services", label: "Window tinting shop" },
};

// "Partner priority" as SQL, for ORDER BY in the partner picks (kept in step with PARTNER_KINDS).
export const PARTNER_PRIORITY_SQL = `CASE p.kind ${Object.entries(PARTNER_KINDS).map(([k, v]) => `WHEN '${k}' THEN ${v.priority}`).join(" ")} ELSE 9 END`;

export function kindLabel(kind) {
  return (PARTNER_KINDS[kind] && PARTNER_KINDS[kind].label) || LAW_KIND_LABELS[kind] || (LOCAL_KINDS[kind] && LOCAL_KINDS[kind].label) || null;
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
  const name = displayName(p.name || "your firm");
  const group = partnerGroup(p);
  if (group === "lawyer") {
    return {
      subject: `A tech contact for ${possessive(name)} clients`,
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
    subject: `A tech contact for ${possessive(name)} clients`,
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
