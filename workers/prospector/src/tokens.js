// Signed board links. A board URL is /ops/b/<expiry>/<signature>: the expiry is a Unix time and the
// signature is HMAC-SHA256 over "board|<expiry>". Only links this Worker put in a digest work, and each
// one stops working after BOARD_DAYS. Nothing about the founder or a prospect is in the URL.
//
// The signing key is the ACTION_KEY secret when one is set; otherwise a random 256-bit key the Worker
// generates once and keeps in its own database (meta 'action_key'). Either way it never appears in the
// repo, and anyone who could read the database could change prospects directly anyway.

const enc = new TextEncoder();
export const BOARD_DAYS = 45;
let cache = { secret: null, key: null };

async function signingSecret(env) {
  if (env && typeof env.ACTION_KEY === "string" && env.ACTION_KEY.length >= 32) return env.ACTION_KEY;
  if (!env || !env.DB) throw new Error("No ACTION_KEY secret and no database to keep a board key in");
  const read = () => env.DB.prepare("SELECT value FROM meta WHERE key = 'action_key'").first();
  let row = await read();
  if (!row) {
    // INSERT OR IGNORE: if two requests race, both end up using whichever key landed first.
    await env.DB.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('action_key', ?)").bind(toB64url(crypto.getRandomValues(new Uint8Array(32)))).run();
    row = await read();
  }
  if (!row || typeof row.value !== "string" || row.value.length < 32) throw new Error("Board key is missing");
  return row.value;
}

async function hmacKey(env) {
  const secret = await signingSecret(env);
  if (cache.secret !== secret) {
    cache = { secret, key: await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]) };
  }
  return cache.key;
}

function toB64url(buf) {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function boardPath(env, now = Date.now()) {
  const exp = Math.floor(now / 1000) + BOARD_DAYS * 86400;
  const sig = toB64url(await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(`board|${exp}`)));
  return `/ops/b/${exp}/${sig}`;
}

export async function boardUrl(env, now) {
  const origin = String(env.BOARD_ORIGIN || "https://mobiusintegration.com").replace(/\/+$/, "");
  return origin + (await boardPath(env, now));
}

// "ok", "expired" (a genuine link past its date) or "bad". The signature is checked first, so a forged
// link never learns anything about expiry.
export async function checkBoard(env, exp, sig, now = Date.now()) {
  if (!/^\d{9,11}$/.test(exp || "") || !/^[A-Za-z0-9_-]{43}$/.test(sig || "")) return "bad";
  let good = false;
  try {
    good = await crypto.subtle.verify("HMAC", await hmacKey(env), fromB64url(sig), enc.encode(`board|${exp}`));
  } catch {
    return "bad";
  }
  if (!good) return "bad";
  return Number(exp) * 1000 > now ? "ok" : "expired";
}
