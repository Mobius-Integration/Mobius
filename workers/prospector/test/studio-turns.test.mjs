import test from "node:test";
import assert from "node:assert/strict";
import { pcAlive, queueStudioTurn, nextStudioTurn, fallbackStudioTurns } from "../src/studio-turns.js";

function dbFixture() {
  const state={seen:new Date().toISOString(),turn:{id:1,input:"hello",deep:0,state:"pending"},calls:0,brief:{name:"Mobius"}};
  return {state,DB:{prepare(sql){let args=[];return{bind(...values){args=values;return this;},async first(){if(sql.includes("studio_pc_seen"))return state.seen?{value:state.seen}:null;if(sql.includes("SELECT id,input,deep"))return state.turn?.state==="pending"?{...state.turn}:null;if(sql.includes("studio_brief"))return{brief:JSON.stringify(state.brief)};if(sql.includes("key='discord'"))return{value:JSON.stringify({channels:{"brand-studio":"channel"}})};return null;},async all(){if(sql.includes("ORDER BY seq"))return{results:[]};return{results:[]};},async run(){if(sql.includes("studio_pc_seen")){state.seen=args[0];return{meta:{changes:1}};}if(sql.includes("INSERT INTO studio_turns")){state.turn={id:state.turn?.id+1||1,input:args[0],deep:args[1],state:"pending"};return{meta:{changes:1}};}if(sql.includes("UPDATE studio_turns SET state='claimed'")){if(state.turn?.id===args[0]&&state.turn.state==="pending"){state.turn.state="claimed";return{meta:{changes:1}};}return{meta:{changes:0}};}if(sql.includes("INSERT INTO studio_messages")&&args[1]==="usage:calls"){state.calls++;return{meta:{changes:1}};}return{meta:{changes:1}};}};}}};
}

test("Studio brain selection uses a recent PC heartbeat unless Cloudflare is forced",async()=>{
  const {state,DB}=dbFixture(),env={DB};
  assert.equal(await pcAlive(env),true);
  env.STUDIO_BRAIN="cloudflare";assert.equal(await pcAlive(env),false);
  env.STUDIO_BRAIN="codex";state.seen=new Date(Date.now()-4*60*1000).toISOString();assert.equal(await pcAlive(env),false);
});

test("Studio queues turns and atomically claims one for the PC",async()=>{
  const {state,DB}=dbFixture(),env={DB};
  await queueStudioTurn(env,"new question",true);
  assert.equal(state.turn.input,"new question");assert.equal(state.turn.deep,1);
  const first=await nextStudioTurn(env);
  assert.equal(first.input,"new question");assert.equal(first.deep,true);assert.equal(state.turn.state,"claimed");
  assert.equal(await nextStudioTurn(env),null);
  assert.equal(state.calls,1);
});

test("Studio fallback sweep answers turns older than four minutes",async(t)=>{
  const state={state:"pending"};
  const env={DISCORD_APP_ID:"app",DISCORD_BOT_TOKEN:"YXBw.x.y",AI:{async run(){return{response:JSON.stringify({reply:"Cloudflare reply",options:[],palette:[],textures:[],brief_updates:{}})};}},DB:{prepare(sql){let args=[];return{bind(...v){args=v;return this;},async first(){if(sql.includes("key='discord'"))return{value:JSON.stringify({channels:{"brand-studio":"channel"}})};if(sql.includes("studio_brief"))return{brief:"{}"};if(sql.includes("FROM studio_turns WHERE id="))return{id:9,input:"hello",state:state.state};return null;},async all(){if(sql.includes("created_at < datetime('now','-4 minutes')"))return{results:[{id:9,input:"hello",state:"pending"}]};return{results:[]};},async run(){if(sql.includes("SET state='fallback'"))state.state="fallback";return{meta:{changes:1}};}};}}};
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});globalThis.fetch=async()=>Response.json({id:"sent"});
  await fallbackStudioTurns(env);assert.equal(state.state,"fallback");
});
