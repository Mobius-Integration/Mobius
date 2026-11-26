import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { handleOps } from "../src/board.js";
import { boardPath } from "../src/tokens.js";
import { notify } from "../src/outbox.js";

globalThis.crypto ||= webcrypto;
const actionKey = "test-action-key-with-more-than-32-characters";
const routeEnv = (discord) => ({ ACTION_KEY: actionKey, DB: { prepare(sql) { let args = []; return { bind(...v) { args = v; return this; }, async first() { return sql.includes("discord") ? { value: JSON.stringify(discord) } : null; }, async run() { return {}; } }; } }, DISCORD_APP_ID: "app", DISCORD_PUBLIC_KEY: "0".repeat(64), DISCORD_BOT_TOKEN: "YXBw.x.y" });
async function url(env, path) { return `https://example.test${await boardPath(env)}${path}`; }
function req(url, method, body) { return new Request(url, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); }

test("held-send notification posts to approvals without sending email", async (t) => {
  const env = routeEnv({ channels: { approvals: "123" } });
  const original = globalThis.fetch; let posted;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, opts) => { posted = [url, JSON.parse(opts.body)]; return Response.json({ id: "message" }); };
  await notify(env, "Held send: Shop", ["Please review"], null, null, { email: false });
  assert.equal(posted[0], "https://discord.com/api/v10/channels/123/messages");
  assert.match(posted[1].content, /Held send/);
});

test("say enforces channel allowlist and content cap", async (t) => {
  const env = routeEnv({ channels: { builds: "123", hq: "456" } });
  const original = globalThis.fetch; const posted = [];
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, opts) => { posted.push([url, JSON.parse(opts.body)]); return Response.json({ id: "msg" }); };
  const good = await handleOps(req(await url(env, "/say"), "POST", { channel: "builds", content: "Codex started" }), env);
  assert.deepEqual(await good.json(), { ok: true });
  for (const body of [{ channel: "approvals", content: "no" }, { channel: "hq", content: "x".repeat(1901) }]) {
    const response = await handleOps(req(await url(env, "/say"), "POST", body), env);
    assert.equal(response.status, 400);
  }
  assert.equal(posted.length, 1);
});

test("tasks filters active forum threads by approved applied tag", async (t) => {
  const env = routeEnv({ guild: "98765432109876543", channels: { tasks: "12345678901234567" } });
  const original = globalThis.fetch; const requested = [];
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname; requested.push(path);
    if (path.endsWith("/channels/12345678901234567")) return Response.json({ available_tags: [{ id: "approved-id", name: "approved" }] });
    if (path.endsWith("/threads/active")) return Response.json({ threads: [
      { id: "12345678901234568", parent_id: "12345678901234567", name: "Approved", applied_tags: ["approved-id"] },
      { id: "12345678901234569", parent_id: "12345678901234567", name: "Proposed", applied_tags: [] },
      { id: "12345678901234570", parent_id: "99999999999999999", name: "Other forum", applied_tags: ["approved-id"] },
    ] });
    if (path.endsWith("/channels/12345678901234568/messages")) { assert.equal(new URL(url).searchParams.get("around"), "12345678901234568"); return Response.json([{ content: "First task details" }]); }
    throw new Error(`Unexpected ${path}`);
  };
  const response = await handleOps(new Request(await url(env, "/tasks")), env);
  assert.deepEqual(await response.json(), [{ id: "12345678901234568", title: "Approved", firstMessage: "First task details", url: "https://discord.com/channels/98765432109876543/12345678901234568" }]);
});

test("task status posts and swaps applied state tags; rejects malformed ids", async (t) => {
  const env = routeEnv({ channels: { tasks: "12345678901234567" } });
  const original = globalThis.fetch; const calls = [];
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, opts = {}) => {
    const path = new URL(url).pathname; calls.push([path, opts.method || "GET", opts.body && JSON.parse(opts.body)]);
    if (path.endsWith("/channels/12345678901234567")) return Response.json({ available_tags: [{ id: "approved", name: "approved" }, { id: "review", name: "review" }] });
    if (path.endsWith("/channels/12345678901234568") && (opts.method || "GET") === "GET") return Response.json({ parent_id: "12345678901234567", applied_tags: ["approved", "other"] });
    if (path.endsWith("/messages")) return Response.json({ id: "message" });
    if (opts.method === "PATCH") return new Response(null, { status: 204 });
    throw new Error(`Unexpected ${opts.method} ${path}`);
  };
  const bad = await handleOps(req(await url(env, "/task"), "POST", { id: "123", status: "review", message: "update" }), env);
  assert.equal(bad.status, 400);
  const response = await handleOps(req(await url(env, "/task"), "POST", { id: "12345678901234568", status: "review", message: "Codex update" }), env);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(calls.at(-1)[2], { applied_tags: ["other", "review"] });
  assert.equal(calls.some((call) => call[1] === "POST" && call[2]?.content === "Codex update"), true);
});
