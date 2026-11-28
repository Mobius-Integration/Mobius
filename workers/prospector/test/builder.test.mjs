import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync,readdirSync } from "node:fs";
import { mkdtempSync,mkdirSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

function db(){const raw=new DatabaseSync(":memory:");for(const f of readdirSync(new URL("../migrations/",import.meta.url)).sort())raw.exec(readFileSync(new URL(`../migrations/${f}`,import.meta.url),"utf8"));return {raw,prepare(sql){let a=[];const s=raw.prepare(sql);return{bind(...x){a=x;return this},async first(){return s.get(...a)||null},async all(){return{results:s.all(...a)}},async run(){const r=s.run(...a);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}}}};}
test("0011 migration columns support queued claim and updates with real SQLite",async()=>{
 const DB=db();DB.raw.prepare("INSERT INTO meta(key,value) VALUES('discord',?)").run(JSON.stringify({channels:{builds:"800"}}));DB.raw.prepare("INSERT INTO office_proposals(run_id,title,why,owner,thread_id,build_state) VALUES(1,'Fix site','Reason','Mario','700','queued')").run();
 const {nextBuilderTask,updateBuilderTask}=await import("../src/builder.js");
 const env={DB,DISCORD_BOT_TOKEN:"YXBw.x.y",DISCORD_APP_ID:"app"};const calls=[];globalThis.fetch=async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return new Response("{}")};
 const task=await nextBuilderTask(env);assert.equal(task.title,"Fix site");assert.equal(await nextBuilderTask(env),null);assert.equal(DB.raw.prepare("SELECT build_state FROM office_proposals WHERE id=1").get().build_state,"claimed");
 assert.equal(await updateBuilderTask(env,{id:1,state:"done",kind:"decision",note:"Use the existing brand palette."}),true);
 assert.equal(await updateBuilderTask(env,{id:1,state:"done",kind:"weird",note:"No"}),false);
 assert.equal(await updateBuilderTask(env,{id:1,state:"done",kind:"content",note:"x".repeat(1501)}),false);
 assert.equal(calls.length,2);assert.ok(calls.every(c=>c.body.allowed_mentions.parse.length===0));
 const brief=JSON.parse(DB.raw.prepare("SELECT brief FROM studio_brief WHERE id=1").get().brief);assert.equal(brief.decisions.at(-1).text,"Use the existing brand palette.");
});

test("Builder PC classifies and dispatches decision, content and code tasks; existing worktree fails cleanly",async()=>{
 const {dispatchTask,dailyCap,dailyCount}=await import("../scripts/builder-pc.mjs");assert.equal(dailyCap(undefined),3);assert.equal(dailyCap("2"),2);assert.equal(dailyCap("99"),20);assert.equal(dailyCount("2026-11-25T08:00 task 1 done\n2026-11-25T09:00 task 2 failed\n2026-11-24T23:00 task 3 done","2026-11-25"),2);const root=mkdtempSync(join(tmpdir(),"builder-pc-test-"));
 try{for(const kind of ["decision","content","code"]){const sends=[];const result={kind,summary:"Summary",finished_piece:"Hi Maria, here is the finished draft text.",mockup_html:"",brief:"Implement the approved change."};
  const spawn=(cmd,args)=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin={end(){if(cmd==="codex"){const out=args[args.indexOf("-o")+1];writeFileSync(out,JSON.stringify(result));}queueMicrotask(()=>child.emit("close",0));}};return child;};
  const outcome=await dispatchTask({id:9,title:"Approved"},{baseUrl:"https://board",fetchImpl:async(url,init)=>{sends.push({url,body:JSON.parse(init.body)});return new Response("{}")},spawn,workRoot:join(root,kind,"work"),briefRoot:join(root,kind,"briefs"),workDir:root});
  assert.equal(outcome.kind,kind);assert.equal(outcome.state,kind==="code"?"ready_for_review":"done");assert.ok(sends.some(x=>x.body.state===outcome.state));
 }
 const existing=join(root,"existing","task-10");mkdirSync(existing,{recursive:true});const sends=[];const spawn=(cmd,args)=>{const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.stdin={end(){if(cmd==="codex")writeFileSync(args[args.indexOf("-o")+1],JSON.stringify({kind:"code",summary:"s",finished_piece:"",mockup_html:"",brief:"brief"}));queueMicrotask(()=>c.emit("close",0));}};return c;};
 const failed=await dispatchTask({id:10,title:"Existing"},{baseUrl:"https://board",fetchImpl:async(u,i)=>{sends.push(JSON.parse(i.body));return new Response("{}")},spawn,workRoot:join(root,"existing"),briefRoot:join(root,"briefs"),workDir:root});assert.equal(failed.reason,"Worktree already exists");assert.equal(sends.at(-1).state,"failed");
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("a 'classifying' update doesn't count as a finished decision or touch the brand brief", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { readdirSync, readFileSync } = await import("node:fs");
  const raw = new DatabaseSync(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) raw.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const DB = { prepare(sql) { let a = []; const st = raw.prepare(sql); return { bind(...v) { a = v; return this; }, async first() { return st.get(...a) ?? null; }, async all() { return { results: st.all(...a) }; }, async run() { const r = st.run(...a); return { meta: { changes: Number(r.changes) } }; } }; } };
  raw.prepare("INSERT INTO meta (key, value) VALUES ('discord', ?)").run(JSON.stringify({ channels: { builds: "900" } }));
  raw.prepare("INSERT INTO office_runs (slot, state) VALUES ('x', 'done')").run();
  raw.prepare("INSERT INTO office_proposals (run_id, title, why, owner, thread_id, build_state) VALUES (1, 'T', 'W', 'Mario', '700', 'claimed')").run();
  const posts = [];
  globalThis.fetch = async (url) => { posts.push(String(url)); return new Response("{}", { status: 200 }); };
  const { updateBuilderTask } = await import("../src/builder.js");
  const before = raw.prepare("SELECT brief FROM studio_brief WHERE id=1").get().brief;
  assert.equal(await updateBuilderTask({ DB, DISCORD_APP_ID: "app", DISCORD_BOT_TOKEN: "YXBw.x.y" }, { id: 1, state: "classifying", kind: "decision", note: "Classifying this approved task." }), true);
  assert.equal(raw.prepare("SELECT build_state FROM office_proposals WHERE id=1").get().build_state, "classifying");
  assert.equal(raw.prepare("SELECT brief FROM studio_brief WHERE id=1").get().brief, before);
  assert.equal(posts.some((u) => u.includes("/channels/900/")), false, "no #builds post for classifying");
});
