// Pure rules for the auto-sender (no database, no network): when it may send, how many a day, what the
// follow-ups say, and how a reply is read. Everything here is unit-tested (see the README).
//
// The founder's rules (2026-11-23): weekdays only, 9:30 AM to 3:30 PM Eastern, a daily cap that ramps up
// from 8 to 20 over about three weeks (a new sender builds reputation slowly), no restaurant emails in
// Thanksgiving week, no sending on major holidays, at most two follow-ups per business, and nothing to
// anyone who replied, bounced or asked to stop.

const ET = "America/New_York";
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ---------------------------------------------------------------------------
// Time (Eastern, with daylight saving)

export function etParts(date) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: ET, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit",
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, dow: DOW.indexOf(p.weekday), h: +p.hour, min: +p.minute, ymd: `${p.year}-${p.month}-${p.day}` };
}

// The UTC instant when the clocks in Tampa read ymd hour:minute.
export function etToUtc(ymd, hour, minute = 0) {
  const [y, m, d] = ymd.split("-").map(Number);
  const want = Date.UTC(y, m - 1, d, hour, minute);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = etParts(new Date(t));
    t += want - Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
  }
  return new Date(t);
}

export const addDays = (ymd, n) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
export const dowOf = (ymd) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

export const sqlTime = (date) => date.toISOString().replace("T", " ").slice(0, 19);
export const parseSql = (s) => new Date(String(s).replace(" ", "T") + "Z");

// ---------------------------------------------------------------------------
// Which days and hours

// nth (1-based) weekday of a month, or the last one for n = -1. dow: 0 = Sunday.
function nthWeekday(year, month, dow, n) {
  const pad = (x) => String(x).padStart(2, "0");
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return `${year}-${pad(month)}-${pad(1 + ((dow - first + 7) % 7) + 7 * (n - 1))}`;
  }
  const last = new Date(Date.UTC(year, month, 0));
  return `${year}-${pad(month)}-${pad(last.getUTCDate() - ((last.getUTCDay() - dow + 7) % 7))}`;
}

// A fixed-date holiday that falls on a weekend is observed on the nearest weekday.
function observed(ymd) {
  const d = dowOf(ymd);
  return d === 6 ? addDays(ymd, -1) : d === 0 ? addDays(ymd, 1) : ymd;
}

export function holidaysFor(year) {
  const thanksgiving = nthWeekday(year, 11, 4, 4);
  return new Set([
    observed(`${year}-01-01`), nthWeekday(year, 5, 1, -1), observed(`${year}-07-04`), nthWeekday(year, 9, 1, 1),
    thanksgiving, addDays(thanksgiving, 1), `${year}-12-24`, observed(`${year}-12-25`), `${year}-12-31`,
  ]);
}

export function isSendDay(ymd) {
  const dow = dowOf(ymd);
  return dow >= 1 && dow <= 5 && !holidaysFor(Number(ymd.slice(0, 4))).has(ymd);
}

export function nextSendDay(ymd) {
  let d = addDays(ymd, 1);
  while (!isSendDay(d)) d = addDays(d, 1);
  return d;
}

export const WINDOW = { start: 9 * 60 + 30, end: 15 * 60 + 30 }; // minutes after midnight, Eastern

// The day before a holiday (the Wednesday before Thanksgiving, Christmas Eve's eve): people leave early,
// and email that arrives in the afternoon waits under a long weekend's pile.
export function isHolidayEve(ymd) {
  return isSendDay(ymd) && holidaysFor(Number(addDays(ymd, 1).slice(0, 4))).has(addDays(ymd, 1));
}

// Since 2026-11-24 the auto-sender sends up to SENDS_PER_TICK emails a run (every 15 minutes), so a day's
// emails fit into the morning, when owners read and answer email.
export const SENDS_PER_TICK = 2;

// The latest first-send time for a day with n first emails (minutes after midnight, Eastern): mornings
// (by 12:30, or 11:45 on a holiday eve), stretched only as far as the 15-minute runs need to fit them,
// and never past 3:15 PM.
export function lastSlotMinutes(ymd, n) {
  const morning = isHolidayEve(ymd) ? 11 * 60 + 45 : 12 * 60 + 30;
  const needed = WINDOW.start + Math.ceil(Math.max(0, n) / SENDS_PER_TICK) * 15 + 15;
  return Math.min(15 * 60 + 15, Math.max(morning, needed));
}

// Is this address a person's (jane@, j.smith@) rather than a shared inbox (info@, office@)? People answer
// cold email far more often than front desks do.
const SHARED_INBOX = /^(info|office|contact|contactus|admin|hello|hi|mail|email|support|help|reception|frontdesk|front\.?desk|team|sales|inquir(y|ies)|intake|service|services|general|law|legal|firm|staff|marketing|billing|accounts?|appointments?|booking|bookings|schedul(e|ing)|hr|jobs|careers|webmaster|web|noreply|no-reply|questions|request|requests|newpatients?|patients?|care|clinic|dental|smile|smiles|spa|salon|shop|store|orders?|hey|connect)([._-]\w{0,12}|\d{1,3})?$/i;
export function personalEmail(email) {
  const local = String(email || "").split("@")[0].toLowerCase();
  return !!local && !SHARED_INBOX.test(local) && !/^(info|office|contact|admin|sales|support)[a-z0-9]{3,}$/.test(local);
}

// 2 = a person's address (jane@, rtodd@), 1 = an address named after the business (smithdental@, often
// the owner's own inbox at a small shop), 0 = a shared inbox (info@, office@, infosmithdental@).
export function emailRank(email, domain) {
  if (!personalEmail(email)) return 0;
  const local = String(email).split("@")[0].toLowerCase().replace(/[^a-z]/g, "");
  const label = String(domain || "").toLowerCase().split(".")[0].replace(/[^a-z]/g, "");
  if (local.length >= 5 && label && (label.includes(local) || local.includes(label.slice(0, Math.max(5, Math.ceil(label.length * 0.6)))))) return 1;
  return 2;
}

export function inWindow(date) {
  const p = etParts(date);
  const mins = p.h * 60 + p.min;
  return isSendDay(p.ymd) && mins >= WINDOW.start && mins <= WINDOW.end;
}

// Monday to Friday of the week that contains Thanksgiving.
export function thanksgivingWeek(ymd) {
  const tg = nthWeekday(Number(ymd.slice(0, 4)), 11, 4, 4);
  return ymd >= addDays(tg, -3) && ymd <= addDays(tg, 1);
}
export const restaurantHold = (category, ymd) => category === "restaurants" && thanksgivingWeek(ymd);

// ---------------------------------------------------------------------------
// How many a day

const int = (v, dflt, min, max) => Math.min(max, Math.max(min, Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : dflt));

// Emails of every kind (first emails and follow-ups) on a day. Starts at AUTO_START_PER_DAY and adds 2
// every 3 days after the first automatic send, up to AUTO_MAX_PER_DAY.
export function dailyCap(env, firstYmd, ymd) {
  const max = int(env && env.AUTO_MAX_PER_DAY, 20, 1, 40);
  const start = Math.min(max, int(env && env.AUTO_START_PER_DAY, 8, 1, 40));
  if (!firstYmd) return start;
  return Math.min(max, start + 2 * Math.floor(Math.max(0, daysBetween(firstYmd, ymd)) / 3));
}

// n send times spread across [start, end] with some jitter, so they don't land on the minute.
export function planSlots(start, end, n, rand = Math.random) {
  const span = end.getTime() - start.getTime();
  if (n <= 0 || span <= 0) return [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const base = start.getTime() + (span * (i + 0.5)) / n;
    out.push(new Date(Math.round(base + (rand() - 0.5) * 0.6 * (span / n))));
  }
  return out.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// What a draft quotes, so the send-time re-check can confirm it is still true

const FAMILIES = [["https", /HTTPS/], ["viewport", /viewport/], ["alt", /alt text/], ["label", /without a label|unlabeled/i], ["booking", /booking/i], ["slow", /Slow/], ["title", /title/], ["desc", /description/]];
export const familyOf = (issue) => { const f = FAMILIES.find(([, re]) => re.test(issue)); return f ? f[0] : null; };
export const familiesOf = (issues) => [...new Set(issues.map(familyOf).filter(Boolean))];

// ---------------------------------------------------------------------------
// Follow-up emails (fixed templates, so they can't drift into claims we haven't made)

const lcFirst = (s) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

// n: 1 = a nudge (day 4), 2 = the last note (a week after that). kind: "client" or "partner". extra: one more
// current finding from a fresh check (client only).
export function followupBody({ n, kind, name, extra }) {
  const who = String(name || "your business").trim();
  if (kind === "partner") {
    return n === 1
      ? "Hi there,\n\nFollowing up on my note about sending clients our way. If it's easier to talk it through, a 15-minute coffee or call works. And if the timing is wrong, no problem at all."
      : "Hi there,\n\nLast note on this one. If sending clients our way ever makes sense, my details are below.\n\nIf you'd rather not hear from me again, just reply STOP.";
  }
  if (n === 1) {
    const more = extra ? ` One more thing from the same quick check: ${lcFirst(extra).replace(/[.\s]+$/, "")}.` : "";
    return `Hi there,\n\nCircling back on my note about ${who}'s website, in case it got buried.${more}\n\nIf it would help, I can send the short write-up with screenshots. Just reply "yes" and I'll send it over.`;
  }
  return `Hi there,\n\nLast note from me. I know an inbox fills up fast, so I won't keep following up. If a second pair of eyes on ${who}'s website would help down the road, my details are below.\n\nIf you'd rather not hear from me again, just reply STOP.`;
}

// ---------------------------------------------------------------------------
// Reading a reply

const STOP_RE = /\b(stop|unsubscribe|remove me|remove us|take me off|take us off|do not (contact|email|call)|don'?t (contact|email|call)|no more (emails?|messages?)|opt[- ]?out|not interested|no thanks?|no thank you)\b/i;
const ANGRY_RE = /\b(spam|spammer|reported?|harass\w*|illegal|cease and desist|attorney general|scam|phishing|fraud|how did you get (my|this))\b/i;
const AUTO_SUBJECT = /^\s*(automatic reply|auto[- ]?reply|autoreply|out of (the )?office|away from|vacation|undeliverable)/i;
const AUTO_TEXT = /\b(out of (the )?office|automatic reply|auto-?reply|i am (currently )?away|on vacation|will respond when i return)\b/i;

// The reply without the quoted email under it.
export function stripQuoted(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const out = [];
  for (const line of lines) {
    if (/^\s*>/.test(line) || /^\s*On .{5,120}wrote:\s*$/i.test(line) || /^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line) || /^\s*From:\s.+/.test(line) && out.length) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

// -> "auto" (an out-of-office or similar, ignored), "angry" (pause everything and tell the founder),
// "stop" (a request to stop or a polite no: suppress them), or "reply" (a person wrote back).
export function classifyReply({ subject = "", text = "", auto = false }) {
  const body = stripQuoted(text).slice(0, 500);
  if (auto || AUTO_SUBJECT.test(subject) || (AUTO_TEXT.test(body.slice(0, 250)) && body.length < 400)) return "auto";
  if (ANGRY_RE.test(body)) return "angry";
  if (STOP_RE.test(body) && body.split(/\s+/).length < 60) return "stop";
  return "reply";
}
