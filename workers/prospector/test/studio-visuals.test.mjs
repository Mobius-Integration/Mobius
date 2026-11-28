import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { substituteMobiusMarks } from "../src/gallery.js";
import { handleStudioInteraction } from "../src/studio.js";
import { doneStudioTurn } from "../src/studio-turns.js";

const reply={reply:"Done",mockup_html:"",options:[],palette:[],textures:[],brief_updates:{}};
function dbFor(handler){return{prepare(sql){let args=[];return{bind(...v){args=v;return this;},first(){return handler(sql,args,"first");},all(){return handler(sql,args,"all");},run(){return handler(sql,args,"run");}};}};}

test("mobius-mark expands to the recolorable real strip without lettering",()=>{
  const html=substituteMobiusMarks('<mobius-mark class="brand" style="--mark-outer:url(#gradient)"/>');
  assert.match(html,/<svg[^>]*class="brand"[^>]*style="--mark-outer:url\(#gradient\)"/);
  assert.match(html,/var\(--mark-outer,#247C78\)/);assert.match(html,/var\(--mark-inner,#294B42\)/);assert.match(html,/var\(--mark-node,#294B42\)/);
  assert.doesNotMatch(html,/fill="black"/i);assert.match(html,/viewBox="1\.3 1\.4 346\.3 209\.7"/);
});

test("option interaction records the label and queues a PC turn",async(t)=>{
  const db=dbFor((sql,args,method)=>{if(method==="first"&&sql.includes("key='discord'"))return{value:JSON.stringify({admins:["admin"],channels:{"brand-studio":"studio"}})};if(method==="first"&&sql.includes("studio_options"))return{labels:'["Try serif"]'};if(method==="first"&&sql.includes("studio_pc_seen"))return{value:new Date().toISOString()};if(method==="first"&&sql.includes("MAX(seq)"))return{seq:7};if(method==="run"&&sql.includes("INSERT INTO studio_turns")){db.turn=args;return{meta:{changes:1}};}return method==="run"?{meta:{changes:1}}:null;});
  const env={DB:db,DISCORD_APP_ID:"app",DISCORD_BOT_TOKEN:"YXBw.x.y"}, waits=[];const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);globalThis.fetch=async()=>new Response(null,{status:204});
  const res=await handleStudioInteraction({channel_id:"studio",data:{custom_id:"studio:opt:3:0"},member:{user:{id:"admin"}}},env,{waitUntil(p){waits.push(p);}});assert.equal(res.type,5);await Promise.all(waits);assert.deepEqual(db.turn,["Try serif",0,7]);
});

test("second deep tap is refused while a deep turn is pending",async()=>{
  let checked=false;const db=dbFor((sql,_args,method)=>{if(method==="first"&&sql.includes("key='discord'"))return{value:JSON.stringify({admins:["admin"],channels:{"brand-studio":"studio"}})};if(method==="first"&&sql.includes("deep=1")){checked=true;return{id:2};}return null;});
  const res=await handleStudioInteraction({channel_id:"studio",data:{custom_id:"studio:deep"},member:{user:{id:"admin"}}},{DB:db},{waitUntil(){throw new Error("must not queue");}});assert.equal(checked,true);assert.equal(res.type,4);assert.match(res.data.content,/Already thinking deeper/);
});

test("stale PC reply is marked stale and never posted",async()=>{
  const sqlite=new DatabaseSync(":memory:");sqlite.exec("CREATE TABLE studio_turns(id INTEGER PRIMARY KEY,input TEXT,state TEXT,source_seq INTEGER,kind TEXT,note TEXT); CREATE TABLE studio_messages(seq INTEGER,author TEXT,content TEXT); CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO studio_turns VALUES(1,'old','claimed',2,'studio',NULL); INSERT INTO studio_messages VALUES(3,'admin','newer'); INSERT INTO meta(key,value) VALUES('discord','{\"channels\":{\"brand-studio\":\"studio\"}}');");
  const db={prepare(sql){let args=[];return{bind(...v){args=v;return this;},first(){if(sql.includes("FROM studio_turns WHERE id=?"))return sqlite.prepare("SELECT id,input,state,source_seq FROM studio_turns WHERE id=?").get(...args);if(sql.includes("key='discord'"))return sqlite.prepare("SELECT value FROM meta WHERE key='discord'").get();if(sql.includes("SELECT seq,author"))return sqlite.prepare("SELECT seq,author,content FROM studio_messages WHERE seq>? AND author NOT LIKE 'bot:%' AND author NOT LIKE 'usage:%' AND author NOT LIKE 'texture:%' AND author NOT LIKE 'texturemsg:%' ORDER BY seq DESC LIMIT 1").get(...args);return null;},run(){if(sql.includes("note='stale'"))sqlite.prepare("UPDATE studio_turns SET state='done',note='stale' WHERE id=?").run(...args);return{meta:{changes:1}};}};}};
  const env={DB:db};const old=globalThis.fetch;let posted=false;globalThis.fetch=async()=>{posted=true;return Response.json({id:"x"});};try{assert.equal(await doneStudioTurn(env,1,reply),true);assert.equal(posted,false);assert.equal(sqlite.prepare("SELECT state,note FROM studio_turns").get().note,"stale");}finally{globalThis.fetch=old;sqlite.close();}
});
