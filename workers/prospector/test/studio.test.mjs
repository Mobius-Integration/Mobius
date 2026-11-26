import test from "node:test";
import assert from "node:assert/strict";
import { contrastRatio, generateTexture, handleStudioInteraction, paletteEmbed, parseStudioReply, pollStudio, replyAI, resolveStudioOption } from "../src/studio.js";

test("Studio JSON replies validate fields and bound button options", () => {
  const valid = { reply: "A warm start.", options: Array.from({ length: 5 }, (_, i) => ({ label: `Option ${i}` })), palette: [{ name: "Gulf", hex: "#167C80", use: "Accent" }], textures: [], brief_updates: {} };
  assert.equal(parseStudioReply(JSON.stringify(valid)).options.length, 4);
  assert.equal(parseStudioReply("not json"), null);
  assert.equal(parseStudioReply(JSON.stringify({ ...valid, palette: [{ name: "bad", hex: "teal", use: "x" }] })), null);
});

test("Studio contrast math uses WCAG luminance ratios", () => {
  assert.equal(contrastRatio("#000000", "#FFFFFF"), 21);
  assert.ok(contrastRatio("#777777", "#FFFFFF") < 4.5);
  const [embed]=paletteEmbed([{name:"Gulf Teal",hex:"#167C80",use:"Accent"},{name:"Paper",hex:"#FFF8E8",use:"Surface"}]);
  assert.equal(embed.title,"Gulf Teal · #167C80");
  assert.equal(embed.color,0x167c80);
  assert.match(embed.description,/Contrast: darkest/);
});

test("Studio option clicks resolve saved labels by button index", () => {
  assert.equal(resolveStudioOption(["Warm", "Direct"], "1"), "Direct");
  assert.equal(resolveStudioOption(["Warm"], "8"), null);
});

test("Studio retries invalid JSON on the main model, tries the backup model, then uses the plain fallback", async () => {
  let calls = 0;
  const env = {
    DB: { prepare() { return { bind() { return this; }, async first() { return { n: 0 }; }, async run() { return { meta: { changes: 1 } }; } }; } },
    AI: { async run() { calls++; return { response: "not JSON" }; } },
  };
  const result = await replyAI(env, {}, [], "Let's talk about color.");
  assert.equal(calls, 3);
  assert.match(result.reply, /trouble shaping/);
  assert.deepEqual(result.options, []);
});

test("Studio daily chat cap blocks model calls with a kind response", async () => {
  let calls=0;
  const env={STUDIO_MAX_CALLS_PER_DAY:"0",DB:{prepare(){return{bind(){return this;},async run(){return{meta:{changes:0}};}};}},AI:{async run(){calls++;}}};
  const result=await replyAI(env,{},[],"hello");
  assert.equal(calls,0);
  assert.match(result.reply,/limit/);
});

test("Studio poll sends after cursor, ignores bots and non-admins, and batches admins", async (t) => {
  const saved = [];
  const db = {
    prepare(sql) {
      let args=[];
      return {
        bind(...v) { args=v; return this; },
        async first() { if(sql.includes("key='discord'"))return {value:JSON.stringify({admins:["admin"],channels:{"brand-studio":"studio-channel"}})}; if(sql.includes("studio_last_seen"))return {value:"10000000000000001"}; return {n:0}; },
        async run() { if(sql.includes("INSERT OR IGNORE INTO studio_messages")){saved.push(args);return {meta:{changes:1}};} return {meta:{changes:1}}; },
        async all() { return {results:[]}; },
      };
    },
  };
  const aiInputs=[];
  const env={DB:db,DISCORD_APP_ID:"app",DISCORD_BOT_TOKEN:"YXBw.x.y",AI:{async run(_model,{messages}){aiInputs.push(messages);return {response:JSON.stringify({reply:"What should it feel like?",options:[],palette:[],textures:[],brief_updates:{}})};}}};
  const original=globalThis.fetch; const requests=[];
  t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async(url,opts={})=>{const u=new URL(url);requests.push([u,opts]);if(u.pathname.endsWith("/messages")&&opts.method!=="POST")return Response.json([{id:"10000000000000004",type:0,author:{id:"admin"},content:"second"},{id:"10000000000000003",type:0,author:{id:"bot",bot:true},content:"ignore bot"},{id:"10000000000000002",type:0,author:{id:"other"},content:"ignore person"},{id:"10000000000000001",type:0,author:{id:"admin"},content:"first"}]);if(u.pathname.endsWith("/messages"))return Response.json({id:"sent"});return new Response(null,{status:204});};
  await pollStudio(env);
  assert.equal(requests[0][0].searchParams.get("after"),"10000000000000001");
  assert.equal(saved.length,2);
  assert.deepEqual(saved.map((x)=>x[2]),["first","second"]);
  assert.equal(aiInputs.length,1);
  assert.equal(aiInputs[0].at(-1).content,"first\nsecond");
  assert.equal(requests.some(([u])=>u.pathname.endsWith("/typing")),true);
});

test("Studio image generation uploads an attachment with texture controls and Keep stores it", async (t) => {
  const id="123e4567-e89b-12d3-a456-426614174000";
  const bytes=new Uint8Array([1,2,3,4]); const stored=new Map(); let brief={textures:[]};
  const db={prepare(sql){let args=[];return{bind(...v){args=v;return this;},async first(){if(sql.includes("discord"))return{value:JSON.stringify({admins:["admin"],channels:{"brand-studio":"studio"}})};if(sql.includes("studio_brief"))return{brief:JSON.stringify(brief)};if(sql.includes("studio_messages"))return{content:JSON.stringify({name:"Gulf ripple",prompt:"gentle ripple marks"})};return null;},async run(){if(sql.includes("UPDATE studio_brief"))brief=JSON.parse(args[0]);return{meta:{changes:1}};}};}};
  const env={DB:db,DISCORD_APP_ID:"app",DISCORD_BOT_TOKEN:"YXBw.x.y",AI:{async run(){return{image:btoa(String.fromCharCode(...bytes))};}},WRITEUPS:{async put(k,v){stored.set(k,v instanceof Uint8Array?v:new Uint8Array(v));},async get(k){return stored.get(k)?.buffer;},async delete(k){stored.delete(k);}}};
  const original=globalThis.fetch;const uploads=[];t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async(url,opts={})=>{uploads.push([url,opts]);if(opts.body instanceof FormData)return Response.json({id:"texture-message"});return Response.json({id:"kept-message"});};
  await generateTexture(env,"studio",{name:"Gulf ripple",prompt:"gentle ripple marks"});
  const form=uploads[0][1].body;const payload=JSON.parse(form.get("payload_json"));
  const keep=payload.components[0].components[0].custom_id;const textureId=keep.split(":").at(-1);
  assert.equal(form.get("files[0]").size,4);
  assert.deepEqual(payload.components[0].components.map(c=>c.label),["Keep","Another take","Subtler","Bolder"]);
  const waits=[];const result=await handleStudioInteraction({channel_id:"studio",data:{custom_id:keep},member:{user:{id:"admin"}}},env,{waitUntil(p){waits.push(p);}});assert.equal(result.type,6);await waits[0];
  assert.equal(stored.has(`brand/texture/${textureId}`),true);
  assert.equal(brief.textures[0].id,textureId);
});

test("Studio reads Responses-API output (gpt-oss) as well as chat output", async () => {
  const { modelText } = await import("../src/studio.js");
  assert.equal(modelText({ output: [{ type: "reasoning", content: [] }, { type: "message", content: [{ type: "output_text", text: "{\"a\":1}" }] }] }), "{\"a\":1}");
  assert.equal(modelText({ response: "hi" }), "hi");
  assert.equal(modelText({ choices: [{ message: { content: "yo" } }] }), "yo");
  assert.equal(modelText(null), "");
});
