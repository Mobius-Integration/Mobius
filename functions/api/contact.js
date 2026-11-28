// POST /api/contact
// Cloudflare Pages Function that receives the lead form (contact page and Free Tech Checkup).
//
// Delivery, in order:
//   1. KV namespace bound as LEADS  -> stores the lead as JSON
//   2. NOTIFY_WEBHOOK_URL (env var)  -> posts a JSON summary (Slack-style "text" plus the fields)
// If neither is configured, or nothing succeeded, we answer 503. We never report success
// for a lead that was not stored or delivered somewhere.
//
// Same-origin only: no CORS headers are sent. IP addresses are never stored.

const MAX_BODY_BYTES = 20 * 1024;
const MIN_FILL_MS = 3000;

const SHORT_MAX = 200;
const MESSAGE_MAX = 5000;

const FIELDS = {
  name: SHORT_MAX,
  email: 254,
  business: SHORT_MAX,
  site_url: 300,
  phone: 50,
  interest: SHORT_MAX,
  preferred_time: SHORT_MAX,
  message: MESSAGE_MAX,
  source: 60,
  ref: 6,
};

const FIELD_LABELS = {
  name: "name",
  email: "email address",
  business: "business name",
  site_url: "website",
  phone: "phone number",
  interest: "what you need help with",
  preferred_time: "best time for a call",
  message: "message",
  ref: "email link code",
};

const FORM_PAGES = ["/contact/", "/free-checkup/"];

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  let wasJson = false;
  try {
    const parsed = await readBody(request);
    body = parsed.fields;
    wasJson = parsed.wasJson;
  } catch (err) {
    const wantsJson = acceptsJson(request) || isJsonType(request);
    if (err && err.code === "too_large") {
      return failure(request, wantsJson, 413, "That message is too long to send. Please shorten it and try again.");
    }
    return failure(request, wantsJson, 400, "We couldn't read that form. Please reload the page and try again.");
  }

  const wantsJson = wasJson || acceptsJson(request);
  const source = cleanSource(body.source);

  // Spam checks: pretend success, store nothing.
  if (isBotTrap(body)) {
    return success(request, wantsJson);
  }

  // Normalize and validate.
  const lead = {};
  for (const key of Object.keys(FIELDS)) {
    lead[key] = clean(body[key], key === "message");
  }

  for (const [key, max] of Object.entries(FIELDS)) {
    if (key === "source") continue;
    if (lead[key].length > max) {
      return failure(
        request,
        wantsJson,
        400,
        `Your ${FIELD_LABELS[key]} is too long. Please keep it under ${max} characters.`,
        source
      );
    }
  }
  if (!lead.name) {
    return failure(request, wantsJson, 400, "Please enter your name.", source);
  }
  if (!lead.email) {
    return failure(request, wantsJson, 400, "Please enter your email address.", source);
  }
  if (!isEmail(lead.email)) {
    return failure(request, wantsJson, 400, "Please enter a valid email address, like name@example.com.", source);
  }
  lead.source = source || "unknown";
  lead.ref = /^[abcdefghjkmnpqrstuvwxyz23456789]{6}$/.test(lead.ref) ? lead.ref : "";

  const receivedAt = new Date();
  const pitch = classifyPitch(lead);
  const record = { ...lead, ...(pitch ? { spam: "pitch" } : {}), received_at: receivedAt.toISOString() };

  const hasKv = !!(env && env.LEADS && typeof env.LEADS.put === "function");
  const hasWebhook = !!(env && typeof env.NOTIFY_WEBHOOK_URL === "string" && env.NOTIFY_WEBHOOK_URL.trim());

  if (!hasKv && !hasWebhook) {
    console.error("contact: no LEADS KV binding and no NOTIFY_WEBHOOK_URL configured; lead not delivered");
    return failure(
      request,
      wantsJson,
      503,
      "Our form isn't able to take messages right now. Please try again shortly.",
      source
    );
  }

  let stored = false;
  let notified = false;

  if (hasKv) {
    try {
      const id = crypto.randomUUID();
      await env.LEADS.put(`lead:${record.received_at}:${id}`, JSON.stringify(record));
      stored = true;
    } catch (err) {
      console.error("contact: KV write failed:", err && err.message);
    }
  }

  if (hasWebhook && !pitch) {
    try {
      const res = await fetch(env.NOTIFY_WEBHOOK_URL.trim(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(webhookPayload(record)),
        signal: AbortSignal.timeout(8000),
      });
      notified = res.ok;
      if (!res.ok) console.error("contact: webhook responded", res.status);
    } catch (err) {
      console.error("contact: webhook failed:", err && err.message);
    }
  }

  if (!stored && !notified) {
    return failure(
      request,
      wantsJson,
      503,
      "We couldn't save your message just now. Please try again shortly.",
      source
    );
  }

  // Lead autopilot (workers/lead-alert): pre-check the lead's website, score the lead,
  // draft a reply and email the owner. Runs after the response is sent, so a slow or
  // failed alert never affects the visitor; the lead is already stored above.
  if (!pitch && env && env.LEAD_ALERT && typeof env.LEAD_ALERT.fetch === "function") {
    const alert = env.LEAD_ALERT.fetch("https://lead-alert.internal/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    })
      .then((res) => {
        if (!res.ok) console.error("contact: lead alert responded", res.status);
      })
      .catch((err) => console.error("contact: lead alert failed:", err && err.message));
    if (typeof context.waitUntil === "function") context.waitUntil(alert);
  }

  return success(request, wantsJson);
}

// Everything that is not POST.
export async function onRequest() {
  return new Response("Method not allowed", {
    status: 405,
    headers: { Allow: "POST", "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// ---------------------------------------------------------------------------

function isJsonType(request) {
  return (request.headers.get("content-type") || "").toLowerCase().includes("application/json");
}

function acceptsJson(request) {
  return (request.headers.get("accept") || "").toLowerCase().includes("application/json");
}

async function readBody(request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw Object.assign(new Error("too large"), { code: "too_large" });
  }

  const text = await readLimited(request);
  const type = (request.headers.get("content-type") || "").toLowerCase();

  if (type.includes("application/json")) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw Object.assign(new Error("bad json"), { code: "bad_body" });
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw Object.assign(new Error("bad json"), { code: "bad_body" });
    }
    return { fields: data, wasJson: true };
  }

  if (type.includes("application/x-www-form-urlencoded") || type === "") {
    const fields = {};
    for (const [k, v] of new URLSearchParams(text)) {
      if (!(k in fields)) fields[k] = v;
    }
    return { fields, wasJson: false };
  }

  throw Object.assign(new Error("unsupported"), { code: "bad_body" });
}

async function readLimited(request) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw Object.assign(new Error("too large"), { code: "too_large" });
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

function clean(value, keepNewlines) {
  if (typeof value === "number" || typeof value === "boolean") value = String(value);
  if (typeof value !== "string") return "";
  // Strip control characters (keep tab and, for messages, line breaks).
  let out = value.replace(keepNewlines ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, " ");
  if (keepNewlines) out = out.replace(/\r\n?/g, "\n");
  return out.trim();
}

function cleanSource(value) {
  const s = clean(value, false).toLowerCase().replace(/[^a-z0-9-]/g, "");
  return s.slice(0, 40);
}

function isEmail(value) {
  return value.length <= 254 && /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]{2,}$/.test(value);
}

export function isBotTrap(body, now = Date.now()) {
  if (clean(body.company_site, false) !== "") return true;
  const started = Number(clean(body.started_at, false));
  if (Number.isFinite(started) && started > 0) {
    const elapsed = now - started;
    // A negative value means the visitor's clock is ahead of ours; don't punish that.
    if (elapsed >= 0 && elapsed < MIN_FILL_MS) return true;
  }
  return false;
}

const PITCH_OFFERS = /\b(?:seo|rank(?:ing)?|google\s+search|search\s+results|backlinks|traffic|leads\s+for\s+you|marketing\s+services|web\s+design\s+services|we\s+help\s+businesses|i\s+can\s+help|proposal|quote)\b/i;
const BIG_NONLOCAL_SITES = new Set(["bbc.com", "cnn.com", "nytimes.com", "wikipedia.org", "youtube.com", "facebook.com", "amazon.com"]);

export function classifyPitch(lead) {
  const emailDomain = String(lead.email || "").split("@").pop().trim().toLowerCase();
  if (emailDomain.includes("mobiusintegration") && emailDomain !== "mobiusintegration.com") return true;
  if (emailDomain === "mobiusintegration.com") return true;

  const message = String(lead.message || "");
  if ((/mobiusintegration\.com|your\s+(?:website|site)/i.test(message)) && PITCH_OFFERS.test(message)) return true;

  const site = String(lead.site_url || "").trim();
  if (site) {
    try {
      const host = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`).hostname.toLowerCase().replace(/^www\./, "");
      if ([...BIG_NONLOCAL_SITES].some((domain) => host === domain || host.endsWith(`.${domain}`))) return true;
    } catch { /* invalid site values are handled as ordinary form data */ }
  }
  return false;
}

function webhookPayload(r) {
  const lines = [
    `New lead from ${r.source}`,
    `Name: ${r.name}`,
    `Email: ${r.email}`,
  ];
  if (r.business) lines.push(`Business: ${r.business}`);
  if (r.site_url) lines.push(`Website: ${r.site_url}`);
  if (r.phone) lines.push(`Phone: ${r.phone}`);
  if (r.interest) lines.push(`Interested in: ${r.interest}`);
  if (r.preferred_time) lines.push(`Best time for a call: ${r.preferred_time}`);
  if (r.message) lines.push(`Message: ${r.message}`);
  return { text: lines.join("\n"), lead: r };
}

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

function success(request, wantsJson) {
  if (wantsJson) {
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: JSON_HEADERS });
  }
  return redirect("/thanks/");
}

function failure(request, wantsJson, status, message, source) {
  if (wantsJson) {
    return new Response(JSON.stringify({ ok: false, error: message }), { status, headers: JSON_HEADERS });
  }
  return redirect(errorTarget(request, source));
}

function redirect(location) {
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
}

// Send people back to the page they came from (known form pages only), with ?error=1.
function errorTarget(request, source) {
  let path = "/contact/";
  try {
    const ref = request.headers.get("referer");
    if (ref) {
      const u = new URL(ref);
      if (u.origin === new URL(request.url).origin && FORM_PAGES.includes(u.pathname)) path = u.pathname;
    }
  } catch {
    /* fall back to the contact page */
  }
  const hash = source ? `#${source}-form-error` : "";
  return `${path}?error=1${hash}`;
}
