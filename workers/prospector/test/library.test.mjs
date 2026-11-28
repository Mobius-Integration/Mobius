import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync,readdirSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { usePiece } from "../src/library.js";
import { handleOps } from "../src/board.js";
import { boardPath } from "../src/tokens.js";
globalThis.crypto ||= webcrypto;

function db(){const raw=new DatabaseSync(":memory:");for(const f of readdirSync(new URL("../migrations/",import.meta.url)).sort())raw.exec(readFileSync(new URL(`../migrations/${f}`,import.meta.url),"utf8"));return {raw,prepare(sql){let a=[];const s=raw.prepare(sql);return{bind(...v){a=v;return this},async first(){return s.get(...a)||null},async all(){return{results:s.all(...a)}},async run(){const r=s.run(...a);return{meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}}}}}

test("Use it inserts ready library pieces by kind and calls the draft agent with the piece subject",async()=>{
 const DB=db();DB.raw.prepare("INSERT INTO meta(key,value) VALUES('agent_url','https://script.google.com/macros/s/abcdefghijklmnopqrst/exec'),('agent_token','test')").run();
 DB.raw.prepare("INSERT INTO office_runs(slot,state) VALUES('x','done')").run();DB.raw.prepare("INSERT INTO office_run_messages(run_id,role,step,message,piece_kind,piece_title,piece_text) VALUES(1,'growth','work','Hi','email_draft','Subject: Local website idea','Hello there. This is a useful draft.')").run();
 let call;const out=await usePiece({DB},1,"standup",{callAgent:async(...a)=>(call=a,{ok:true})});assert.equal(out.message,"Draft saved in Gmail.");assert.equal(call[1],"draft");assert.deepEqual(call[2],{to:"",subject:"Local website idea",body:"Hello there. This is a useful draft."});
 assert.deepEqual({...DB.raw.prepare("SELECT kind,title,body,source,state FROM library").get()},{kind:"email_draft",title:"Subject: Local website idea",body:"Hello there. This is a useful draft.",source:"standup",state:"ready"});DB.raw.close();
});

test("walk-in kit requires a signed board token and escapes saved text",async()=>{
 const raw=db();raw.raw.prepare("INSERT INTO library(kind,title,body,source,source_ref) VALUES('walkin_script','<title>','<script>alert(1)</script>&','standup','1')").run();
 const env={ACTION_KEY:"test-action-key-with-more-than-32-characters",DB:raw};const path=await boardPath(env);const req=new Request(`https://example.test${path}/kit`);const denied=await handleOps(new Request("https://example.test/ops/b/1234567890/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/kit"),env);assert.equal(denied.status,404);
 const res=await handleOps(req,env);const html=await res.text();assert.equal(res.status,200);assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;&amp;/);assert.doesNotMatch(html,/<script>alert/);assert.match(html,/@page\{size:Letter/);raw.raw.close();
});
