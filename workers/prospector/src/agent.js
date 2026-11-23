// The founder's outbox: a small Google Apps Script that runs inside his own mario@ mailbox
// (scripts/agent/Code.gs). This Worker never holds mail credentials. It asks the script to send one
// email, and to report replies and bounces, and the script keeps its own hard limits (a daily ceiling,
// no own-domain recipients, the marketing notice required in every body).
//
// Why not Cloudflare's email sending: its docs say Email Service supports transactional email only,
// not marketing, and a suspended Cloudflare account would take the site down with it. Sending from the
// real mailbox also keeps every email in his Sent folder and every reply in his inbox.
//
// The script is called with a long random token. Only the token's SHA-256 is in the script; the token
// itself lives in this Worker's database (meta.agent_token).

const PATH = /^\/(a\/macros\/[A-Za-z0-9.-]+|macros)\/s\/[A-Za-z0-9_-]{20,}\/exec$/;

// Only a Google Apps Script web app address (or a local test server when AGENT_ALLOW_LOCAL is set in
// .dev.vars), so a changed address can't point the token somewhere else.
export function validAgentUrl(url, allowLocal = false) {
  try {
    const u = new URL(url);
    if (allowLocal && u.protocol === "http:" && /^(127\.0\.0\.1|localhost)$/.test(u.hostname)) return true;
    return u.protocol === "https:" && u.hostname === "script.google.com" && PATH.test(u.pathname);
  } catch {
    return false;
  }
}

export async function callAgent(cfg, action, payload = {}, { timeoutMs = 90000 } = {}) {
  if (!validAgentUrl(cfg.url, cfg.allowLocal)) throw new Error("The agent address isn't a Google Apps Script web app address.");
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ ...payload, action, token: cfg.token }),
    redirect: "follow", // Apps Script answers a POST with a redirect to the stored response
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`The agent didn't answer with JSON (HTTP ${res.status}). It may need to be re-authorized.`);
  }
}
