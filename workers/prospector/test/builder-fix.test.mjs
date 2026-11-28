import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

function fakeCodex(answers) {
  const prompts = [];
  const spawn = (cmd, args) => {
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    let input = "";
    c.stdin = { end(text) { input = String(text || ""); if (cmd === "codex") { prompts.push(input); writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify(answers[Math.min(prompts.length - 1, answers.length - 1)])); } queueMicrotask(() => c.emit("close", 0)); } };
    return c;
  };
  return { spawn, prompts };
}

test("Builder retries once when it restates the task, then posts the finished piece and its visual", async () => {
  const { dispatchTask, looksLikeInstruction } = await import("../scripts/builder-pc.mjs");
  const lazy = { kind: "content", summary: "s", finished_piece: "Create one sample page for the outreach PDF using the palette.", mockup_html: "", brief: "" };
  const real = { kind: "content", summary: "Sample page made", finished_piece: "Sample page: cover with the write-up title and three findings.", mockup_html: "<div style='background:#247C78'>Page</div>", brief: "" };
  assert.equal(looksLikeInstruction(lazy), true);
  assert.equal(looksLikeInstruction(real), false);
  const { spawn, prompts } = fakeCodex([lazy, real]);
  const sends = [];
  const root = mkdtempSync(join(tmpdir(), "builder-fix-"));
  try {
    const out = await dispatchTask({ id: 15, title: "Mock the palette on a PDF page", why: "w", owner: "Studio", context: { palette: "Approved: Gulf Teal #247C78" } },
      { baseUrl: "https://board", fetchImpl: async (u, i) => { sends.push(JSON.parse(i.body)); return new Response("{}"); }, spawn, workDir: root, workRoot: join(root, "w"), briefRoot: join(root, "b") });
    assert.equal(out.state, "done");
    assert.equal(prompts.length, 2, "one retry");
    assert.match(prompts[0], /Gulf Teal #247C78/, "brand context reaches the model");
    assert.match(prompts[1], /restated the task/);
    const done = sends.at(-1);
    assert.equal(done.state, "done"); assert.equal(done.kind, "content");
    assert.match(done.note, /^Sample page:/);
    assert.match(done.mockup_html, /#247C78/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Builder accepts the second answer even if it still looks like an instruction (no false failures)", async () => {
  const { dispatchTask } = await import("../scripts/builder-pc.mjs");
  const lazy = { kind: "content", summary: "s", finished_piece: "Make the handoff line bigger.", mockup_html: "", brief: "" };
  const { spawn, prompts } = fakeCodex([lazy, lazy]);
  const sends = [];
  const out = await dispatchTask({ id: 16, title: "t" }, { baseUrl: "https://board", fetchImpl: async (u, i) => { sends.push(JSON.parse(i.body)); return new Response("{}"); }, spawn, workDir: tmpdir() });
  assert.equal(out.state, "done"); assert.equal(prompts.length, 2); assert.equal(sends.at(-1).mockup_html, undefined);
});

function db() {
  const raw = new DatabaseSync(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) raw.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  return { raw, prepare(sql) { let a = []; const s = raw.prepare(sql); return { bind(...x) { a = x; return this; }, async first() { return s.get(...a) || null; }, async all() { return { results: s.all(...a) }; }, async run() { const r = s.run(...a); return { meta: { changes: Number(r.changes) } }; } }; } };
}

test("updateBuilderTask takes a mockup, rejects an oversized one, and survives having no renderer", async () => {
  const DB = db();
  DB.raw.prepare("INSERT INTO meta(key,value) VALUES('discord',?)").run(JSON.stringify({ guild: "1", channels: { builds: "800", gallery: "900" } }));
  DB.raw.prepare("INSERT INTO office_proposals(run_id,title,why,owner,thread_id,build_state) VALUES(1,'Mock page','w','Studio','700','claimed')").run();
  const posts = []; globalThis.fetch = async (url) => { posts.push(String(url)); return new Response("{}"); };
  const { updateBuilderTask, nextBuilderTask } = await import("../src/builder.js");
  const env = { DB, DISCORD_BOT_TOKEN: "YXBw.x.y", DISCORD_APP_ID: "app" };
  assert.equal(await updateBuilderTask(env, { id: 1, state: "done", kind: "content", note: "Page text", mockup_html: "x".repeat(14001) }), false);
  assert.equal(await updateBuilderTask(env, { id: 1, state: "done", kind: "content", note: "Page text", mockup_html: "<p>Page</p>" }), true);
  assert.ok(!posts.some((u) => u.includes("/channels/900/")), "no gallery post without a renderer");
  DB.raw.prepare("INSERT INTO office_proposals(run_id,title,why,owner,thread_id,build_state) VALUES(1,'Next','w','Studio','701','queued')").run();
  const t = await nextBuilderTask(env);
  assert.equal(t.title, "Next"); assert.match(t.context.palette, /Beach Pop/); assert.equal(typeof t.context.brand_brief, "string");
});

test("agents get the live email body without the signature, footer, phone or email", async () => {
  const { emailForAgents } = await import("../src/office.js");
  const body = "Hi there,\n\nHeads up: Chrome is labeling x.com \"Not secure\".\n\nCall me at (813) 555-0100 or a@b.com.\n\nMario Barillas\nFounder\n(813) 798-9191\n\nThis is a marketing email from Mobius Integration, 123 Secret St";
  const e = emailForAgents("\"Not secure\" warning on X's site", body);
  assert.match(e.body, /Heads up/);
  assert.ok(!/Secret St|marketing email|798-9191|555-0100|a@b\.com/.test(e.body));
  assert.equal(emailForAgents("s", ""), null);
});
