import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { verifyDiscordRequest, handleDiscord, discordSend, setupDiscord } from "../src/discord.js";

globalThis.crypto ||= webcrypto;
const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keyPair.publicKey)).toString("hex");
const privateKey = keyPair.privateKey;
const signatureRequest = async (body, timestamp = String(Math.floor(Date.now() / 1000))) => {
  const bytes = new TextEncoder().encode(timestamp + JSON.stringify(body));
  const sig = Buffer.from(await crypto.subtle.sign("Ed25519", privateKey, bytes)).toString("hex");
  return new Request("https://example.test/discord/interactions", { method: "POST", headers: { "x-signature-ed25519": sig, "x-signature-timestamp": timestamp }, body: JSON.stringify(body) });
};

test("Ed25519 request signatures accept valid requests and reject changed or old payloads", async () => {
  const body = { type: 1 };
  assert.equal(await verifyDiscordRequest(await signatureRequest(body), publicKey), true);
  const tampered = await signatureRequest(body);
  const text = await tampered.text();
  const sig = tampered.headers.get("x-signature-ed25519");
  const timestamp = tampered.headers.get("x-signature-timestamp");
  const altered = new Request(tampered.url, { method: "POST", headers: { "x-signature-ed25519": sig, "x-signature-timestamp": timestamp }, body: text + " " });
  assert.equal(await verifyDiscordRequest(altered, publicKey), false);
  assert.equal(await verifyDiscordRequest(await signatureRequest(body, "1"), publicKey), false);
});

function fakeDb(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    prepare(sql) {
      let args = [];
      return {
        bind(...v) { args = v; return this; },
        async first() {
          if (sql.includes("key='discord'")) return values.has("discord") ? { value: values.get("discord") } : null;
          if (sql.includes("FROM meta WHERE key = 'discord'")) return { value: values.get("discord") };
          if (sql.includes("SELECT key, value FROM meta")) return { key: args[0], value: values.get(args[0]) };
          if (sql.includes("SELECT p.id") && sql.includes("prospects")) return { id: args[0], domain: "x.test", name: "X", status: args[0] === 42 ? "digested" : "sent", oid: 1, auto_state: "queued", sent_at: "now", no_followups: 0 };
          return null;
        },
        async all() { return { results: [] }; },
        async run() {
          if (sql.includes("INSERT INTO meta")) values.set(args[0], args[1]);
          if (sql.includes("DELETE FROM meta")) values.delete(args[0]);
          return { meta: { changes: 1 } };
        },
      };
    },
    async batch() { return []; },
  };
}

test("PING and all registered buttons dispatch against fake D1", async () => {
  const db = fakeDb({ discord: JSON.stringify({ admins: ["admin"] }) });
  const env = { DB: db, DISCORD_PUBLIC_KEY: publicKey };
  const ping = await handleDiscord(await signatureRequest({ type: 1 }), env, {});
  assert.deepEqual(await ping.json(), { type: 1 });
  for (const [custom_id, expected] of [["auto:pause", "Auto-send paused."], ["auto:resume", "Auto-send resumed."]]) {
    const response = await handleDiscord(await signatureRequest({ type: 3, data: { custom_id }, member: { user: { id: "admin" } } }), env, {});
    assert.equal((await response.json()).data.content, expected);
  }
  for (const custom_id of ["prospect:cancel:42", "prospect:nofollow:43"]) {
    const response = await handleDiscord(await signatureRequest({ type: 3, data: { custom_id }, member: { user: { id: "admin" } } }), env, {});
    const result = await response.json(); assert.equal(result.type, 7, `${custom_id}: ${result.data?.content}`);
  }
  const denied = await handleDiscord(await signatureRequest({ type: 3, data: { custom_id: "auto:pause" }, member: { user: { id: "else" } } }), env, {});
  assert.match((await denied.json()).data.content, /Not allowed/);
});

test("discordSend posts with bot auth and retries one 429", async (t) => {
  const db = fakeDb({ discord: JSON.stringify({ channels: { hq: "123" } }) });
  const env = { DB: db, DISCORD_APP_ID: "app", DISCORD_PUBLIC_KEY: publicKey, DISCORD_BOT_TOKEN: "secret-token" };
  let calls = 0;
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (_url, opts) => {
    calls++;
    assert.equal(opts.headers.Authorization, "Bot secret-token");
    return calls === 1 ? new Response(JSON.stringify({ retry_after: 0 }), { status: 429 }) : Response.json({ id: "ok" });
  };
  assert.equal((await discordSend(env, "hq", { content: "hello" })).id, "ok");
  assert.equal(calls, 2);
});

test("slow button actions defer the update and finish the original message", async (t) => {
  const env = { DB: fakeDb({ discord: JSON.stringify({ admins: ["admin"] }) }), DISCORD_PUBLIC_KEY: publicKey, DISCORD_BOT_TOKEN: "secret-token" };
  const waits = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, opts) => {
    assert.match(url, /\/channels\/channel\/messages\/message$/);
    assert.equal(opts.method, "PATCH");
    return Response.json({ id: "message" });
  };
  const response = await handleDiscord(await signatureRequest({ type: 3, data: { custom_id: "prospect:cancel:42" }, member: { user: { id: "admin" } }, channel_id: "channel", message: { id: "message" } }), env, { waitUntil(promise) { waits.push(promise); } });
  assert.equal((await response.json()).type, 6);
  await waits[0];
});

test("setup creates Discord resources once and persists ids", async (t) => {
  const db = fakeDb();
  const env = { DB: db, DISCORD_APP_ID: "app", DISCORD_PUBLIC_KEY: publicKey, DISCORD_BOT_TOKEN: "secret-token" };
  const channels = [];
  let creations = 0;
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    if (path === "/api/v10/guilds/12345678901234567") return Response.json({ id: "12345678901234567", owner_id: "98765432109876543" });
    if (path === "/api/v10/guilds/12345678901234567/channels" && opts.method === "GET") return Response.json(channels);
    if (path === "/api/v10/users/@me") return Response.json({ id: "bot" });
    if (path.endsWith("/channels") && opts.method === "POST") {
      const data = JSON.parse(opts.body); const row = { ...data, id: String(++creations), parent_id: data.parent_id };
      channels.push(row); return Response.json(row);
    }
    throw new Error(`Unexpected ${opts.method} ${path}`);
  };
  assert.equal((await setupDiscord(env, "12345678901234567")).ok, true);
  const count = creations;
  assert.equal((await setupDiscord(env, "12345678901234567")).ok, true);
  assert.equal(creations, count);
  assert.equal(JSON.parse(db.values.get("discord")).admins[0], "98765432109876543");
});
