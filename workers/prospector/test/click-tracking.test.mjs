import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

function makeDb() {
  const raw = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../migrations/", import.meta.url)).sort()) {
    raw.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  return {
    raw,
    prepare(sql) {
      let args = [];
      const stmt = raw.prepare(sql);
      return {
        bind(...values) { args = values; return this; },
        async first() { return stmt.get(...args) || null; },
        async all() { return { results: stmt.all(...args) }; },
        async run() { const result = stmt.run(...args); return { meta: { changes: Number(result.changes) } }; },
      };
    },
  };
}

function seed(db, { code, sentAt = "2026-11-25 12:00:00" }) {
  db.raw.prepare("INSERT INTO prospects(id,osm_key,domain,website,name,category) VALUES(1,'node/1','example.com','https://example.com','Example','retail')").run();
  db.raw.prepare("INSERT INTO outreach(id,prospect_id,digest_date,draft_subject,link_code,sent_at) VALUES(1,1,'2026-11-25','A subject',?,?)").run(code, sentAt);
}

test("outreach link code is created once and signature replacement leaves message text alone", async () => {
  const db = makeDb();
  seed(db, { code: null });
  const { codeForOutreach, linkedBody } = await import("../src/outbox.js");
  const row = { oid: 1 };
  const first = await codeForOutreach(db, row);
  const second = await codeForOutreach(db, { ...row, link_code: first });
  assert.match(first, /^[abcdefghjkmnpqrstuvwxyz23456789]{6}$/);
  assert.equal(second, first);
  const { TEXT_SIGNATURE } = await import("../src/digest.js");
  const body = `See mobiusintegration.com in the sentence.\n\n${TEXT_SIGNATURE}`;
  const sent = linkedBody(body, first);
  assert.match(sent, new RegExp(`mobiusintegration\\.com/r/${first}$`));
  assert.match(sent, /See mobiusintegration\.com in the sentence\./);
  assert.equal(db.raw.prepare("SELECT link_code FROM outreach WHERE id=1").get().link_code, first);
});

test("redirect logs human clicks, classifies scanners, HEAD and recent sends, and sends unknown codes home", async () => {
  const db = makeDb();
  seed(db, { code: "abc234" });
  const raw = db.raw;
  for (const [id, code, sentAt] of [[2,"def234","2026-11-25 12:00:00"],[3,"ghj234",new Date().toISOString().replace("T"," ").slice(0,19)]]) {
    raw.prepare("INSERT INTO outreach(id,prospect_id,digest_date,link_code,sent_at) VALUES(?,1,'2026-11-25',?,?)").run(id,code,sentAt);
  }
  const { default: worker } = await import("../src/index.js");
  const env = { DB: db };
  const hit = (path, headers = {}, method = "GET") => worker.fetch(new Request(`https://mobiusintegration.com${path}`, { method, headers }), env);
  let response = await hit("/r/abc234", { "user-agent": "Mozilla/5.0 Chrome/130 Safari/537.36" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://mobiusintegration.com/?ref=abc234");
  response = await hit("/r/abc234", { "user-agent": "Proofpoint URL Defense" });
  response = await hit("/r/abc234", { "user-agent": "GoogleImageProxy" });
  response = await hit("/r/abc234", { "user-agent": "Mozilla/5.0" }, "HEAD");
  response = await hit("/r/def234", { "user-agent": "Mozilla/5.0 Chrome/130" });
  response = await hit("/r/ghj234", { "user-agent": "Mozilla/5.0 Chrome/130" });
  response = await hit("/r/unknown", { "user-agent": "Mozilla/5.0" });
  assert.equal(response.headers.get("location"), "https://mobiusintegration.com/");
  const clicks = raw.prepare("SELECT likely_bot,ua_kind FROM clicks WHERE code='abc234' ORDER BY id").all();
  assert.deepEqual(clicks.map(x => x.likely_bot), [0,1,1]);
  assert.equal(raw.prepare("SELECT likely_bot FROM clicks WHERE code='def234'").get().likely_bot, 0);
  assert.equal(raw.prepare("SELECT likely_bot FROM clicks WHERE code='ghj234'").get().likely_bot, 1);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM clicks").get().n, 5);
  assert.equal(raw.prepare("SELECT COUNT(DISTINCT outreach_id) AS n FROM clicks WHERE likely_bot=0").get().n, 2);
});

test("the daily outreach summary lists human clickers and excludes scanner hits", async () => {
  const db = makeDb();
  seed(db, { code: "abc234" });
  db.raw.prepare("INSERT INTO meta(key,value) VALUES('discord',?)").run(JSON.stringify({ channels: { outreach: "42" } }));
  db.raw.prepare("INSERT INTO clicks(code,outreach_id,prospect_id,clicked_at,likely_bot,ua_kind) VALUES('abc234',1,1,'2026-11-30 16:00:00',0,'browser'),('abc234',1,1,'2026-11-30 16:01:00',1,'scanner')").run();
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return Response.json({ id: "message-1" }); };
  try {
    const { postOutreachSummary } = await import("../src/outbox.js");
    const env = { DB: db, DISCORD_APP_ID: "app", DISCORD_PUBLIC_KEY: "0".repeat(64), DISCORD_BOT_TOKEN: "YXBw.x.y" };
    assert.equal(await postOutreachSummary(env, new Date("2026-11-30T18:00:00Z")), true);
    assert.match(calls[0].content, /Clicked today: Example/);
    assert.doesNotMatch(calls[0].content, /scanner/);
  } finally { globalThis.fetch = oldFetch; }
});
