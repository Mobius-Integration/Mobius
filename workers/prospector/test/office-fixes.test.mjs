// Office regressions found in review (2026-11-26), run against a real SQLite database with the real migrations.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";

function makeDb() {
  const raw = new DatabaseSync(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) raw.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const wrap = (sql) => {
    let args = [];
    const st = raw.prepare(sql);
    return {
      bind(...a) { args = a; return this; },
      async first() { return st.get(...args) ?? null; },
      async all() { return { results: st.all(...args) }; },
      async run() { const r = st.run(...args); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    };
  };
  return { raw, prepare: wrap, async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.all()); return out; } };
}

function setup() {
  const DB = makeDb();
  DB.raw.prepare("INSERT INTO meta (key, value) VALUES ('discord', ?)").run(JSON.stringify({
    admins: ["1"], channels: { office: "100", tasks: "200", hq:"400", "brand-studio": "300" }, webhooks: { office: { id: "9", token: "tok" } },
  }));
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: init.body });
    if (String(url).includes("/channels/200") && (init.method || "GET") === "GET") return Response.json({ available_tags: [{ id: "t1", name: "proposed" },{id:"t2",name:"approved"},{id:"t3",name:"done"}] });
    if (String(url).endsWith("/threads")) return Response.json({ id: "700" });
    return Response.json({ id: "555" });
  };
  const env = { DB, DISCORD_APP_ID: "app", DISCORD_PUBLIC_KEY: "0".repeat(64), DISCORD_BOT_TOKEN: "YXBw.x.y" };
  return { env, DB, calls };
}

test("approving an office proposal queues its Builder job", async () => {
  const {env,DB}=setup();
  DB.raw.prepare("INSERT INTO office_runs(slot,state) VALUES('approve-test','done')").run();
  DB.raw.prepare("INSERT INTO office_proposals(run_id,title,why,owner,thread_id) VALUES(1,'Update content','Reason','Mario','700')").run();
  const {handleOfficeInteraction}=await import("../src/office.js");
  const result=await handleOfficeInteraction({data:{custom_id:"office:proposal:approve:1"},member:{user:{id:"1"}}},env);
  assert.equal(result.type,6);
  assert.deepEqual({...DB.raw.prepare("SELECT state,build_state FROM office_proposals WHERE id=1").get()},{state:"approved",build_state:"queued"});
});

test("agent messages go into the standup thread (thread_id as a query parameter)", async () => {
  const { env, DB, calls } = setup();
  DB.raw.prepare("INSERT INTO office_runs (slot, state, thread_id) VALUES ('2026-11-28 12', 'active', '600')").run();
  const { officeTurnResult } = await import("../src/office.js");
  const raw = { message: "Auto shops reply 3x more.", proposals_json: JSON.stringify([{ title: "Shift the mix", why: "Reply data", effort: "small" }]), notebook: "Watching auto shops.", texture_prompts: [],mockup_html:"",piece_kind:"other",piece_title:"Outreach note",piece_text:"Ready text" };
  const ok = await officeTurnResult(env, { run_id: 1, role: "growth", step: "work" }, raw, false);
  assert.equal(ok, true);
  const post = calls.find((c) => c.url.includes("/webhooks/9/tok"));
  assert.ok(post, "posted through the webhook");
  assert.match(post.url, /[?&]thread_id=600/);
  assert.equal("thread_id" in JSON.parse(post.body), false);
  assert.match(JSON.parse(post.body).content, /Draft proposals:\n• Shift the mix/);
  // Work turns don't create #tasks posts; only Chief's wrap does.
  assert.equal(calls.some((c) => c.url.endsWith("/channels/200/threads")), false);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM office_proposals").get().n, 0);
});

test("a backup turn with an empty notebook keeps the agent's notebook", async () => {
  const { env, DB } = setup();
  DB.raw.prepare("INSERT INTO office_runs (slot, state, thread_id) VALUES ('2026-11-28 15', 'active', '600')").run();
  DB.raw.prepare("INSERT OR REPLACE INTO office_agents (role, notebook) VALUES ('studio', 'Palette v2 in progress')").run();
  const { officeTurnResult } = await import("../src/office.js");
  await officeTurnResult(env, { run_id: 1, role: "studio", step: "work" }, { message: "Backup", proposals_json: "[]", notebook: "", texture_prompts: [] }, true);
  assert.equal(DB.raw.prepare("SELECT notebook FROM office_agents WHERE role='studio'").get().notebook, "Palette v2 in progress");
});

test("texture images (base64 from Workers AI) are posted into the thread", async () => {
  const { env, DB, calls } = setup();
  DB.raw.prepare("INSERT INTO office_runs (slot, state, thread_id) VALUES ('2026-11-28 18', 'active', '600')").run();
  env.AI = { run: async () => ({ image: Buffer.from("fake-jpeg").toString("base64") }) };
  const { officeTurnResult } = await import("../src/office.js");
  await officeTurnResult(env, { run_id: 1, role: "studio", step: "work" }, { message: "Texture study", proposals_json: "[]", notebook: "n", texture_prompts: ["blueprint grid on cream paper"],piece_kind:"design",piece_title:"Texture",piece_text:"",mockup_html:"" }, false);
  const img = calls.find((c) => c.url.includes("/webhooks/9/tok") && c.body instanceof FormData);
  assert.ok(img, "an image upload went to the webhook");
  assert.match(img.url, /thread_id=600/);
});

test("a stalled standup is closed so it can't block the next one", async () => {
  const { env, DB } = setup();
  DB.raw.prepare("INSERT INTO office_runs (slot, state, thread_id, created_at) VALUES ('2026-11-28 09', 'active', '600', datetime('now','-2 hours'))").run();
  const { pollOffice } = await import("../src/office.js");
  await pollOffice(env);
  assert.equal(DB.raw.prepare("SELECT state FROM office_runs WHERE slot='2026-11-28 09'").get().state, "failed");
});

test("a manual standup (Run a standup now) creates its thread and queues Chief's opening", async () => {
  const { env, DB, calls } = setup();
  const { startOfficeRun } = await import("../src/office.js");
  const r = await startOfficeRun(env, { manual: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  const thread = calls.find((c) => c.url.endsWith("/threads") && c.url.includes("/channels/100/messages/"));
  assert.ok(thread, "thread created from the starter message");
  assert.match(JSON.parse(thread.body).name, /^Standup · \w{3} \w{3} \d{1,2} · \d{1,2} (AM|PM) \(test run\)$/);
  assert.equal(DB.raw.prepare("SELECT thread_id FROM office_runs WHERE id=?").get(r.id).thread_id, "700");
  const turn = DB.raw.prepare("SELECT role, step, state FROM studio_turns WHERE kind='office' AND run_id=?").get(r.id);
  assert.deepEqual({ ...turn }, { role: "chief", step: "open", state: "pending" });
});

test("wrap posts plain proposals (If you approve / Why / Effort) and names the thread after its topic", async () => {
  const { env, DB, calls } = setup();
  DB.raw.prepare("INSERT INTO office_runs (slot, state, thread_id) VALUES ('2026-11-28 21', 'active', '600')").run();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => (String(url).endsWith("/channels/600") && (init.method || "GET") === "GET") ? Response.json({ name: "Standup · Sat Nov 28 · 9 PM" }) : realFetch(url, init);
  const { officeTurnResult } = await import("../src/office.js");
  const raw = { summary: "Done.", thread_title: "Follow-up test + palette", notebook: "n",
    proposals: [{ title: "Change the day-4 follow-up to offer the write-up first (next 6 sends)", if_approved: "The Builder changes one email template on a branch for review.", why: "0 replies from 18 sends so far.", effort: "small: one email template", owner: "Builder" }] };
  assert.equal(await officeTurnResult(env, { run_id: 1, role: "chief", step: "wrap" }, raw, false), true);
  const post = calls.find((c) => c.url.endsWith("/channels/200/threads"));
  const content = JSON.parse(post.body).message.content;
  assert.match(content, /^\*\*If you approve:\*\* The Builder changes one email template/);
  assert.match(content, /\*\*Effort:\*\* small: one email template/);
  const rename = calls.find((c) => c.url.endsWith("/channels/600") && c.method === "PATCH");
  assert.equal(JSON.parse(rename.body).name, "Standup · Sat Nov 28 · 9 PM · Follow-up test + palette");
  assert.equal(JSON.parse(rename.body).archived, true);
});

test("evening summary has populated sections, omits empty sections, and stays concise", async()=>{
 const {eveningSummaryText}=await import("../src/office.js");
 const text=eveningSummaryText({made:[{guild:"g",channel_id:"c",message_id:"m",caption:"A useful mockup"}],proposals:[{title:"Approve",guild:"g",channel_id:"t",thread_id:"p"}],outreach:{first:2,follow:0,clicks:1,replies:1,bounces:0}});
 assert.match(text,/Made today: 1 #gallery post/);assert.match(text,/A useful mockup — https:\/\/discord.com\/channels\/g\/c\/m/);assert.match(text,/Needs your tap:\nProposal: Approve/);assert.match(text,/Outreach today: first emails 2 · follow-ups 0 · human clicks 1 · replies 1 · bounces 0/);
 assert.equal(eveningSummaryText(),"Nothing new today.");assert.ok(text.length<1900);
});

test("evening summary posts at 9:30 PM New York once per day",async()=>{
 const {env,DB,calls}=setup();const {postEveningSummary}=await import("../src/office.js");const now=new Date("2026-11-28T02:30:00Z");
 assert.equal(await postEveningSummary(env,new Date("2026-11-28T02:29:00Z")),false);assert.equal(await postEveningSummary(env,now),true);assert.equal(await postEveningSummary(env,now),false);
 assert.equal(calls.filter(c=>c.url.endsWith("/channels/400/messages")).length,1);
});
