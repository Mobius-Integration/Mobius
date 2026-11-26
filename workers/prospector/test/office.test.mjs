import test from "node:test";
import assert from "node:assert/strict";
import { officeSlot, strictOfficeResult, escapeMentions } from "../src/office.js";

test("office slots follow New York wall time across daylight saving",()=>{
 assert.equal(officeSlot(new Date("2026-01-15T14:00:00Z")),"2026-01-15 09");
 assert.equal(officeSlot(new Date("2026-07-15T13:00:00Z")),"2026-07-15 09");
 assert.equal(officeSlot(new Date("2026-03-08T13:00:00Z")),"2026-03-08 09");
 assert.equal(officeSlot(new Date("2026-11-01T14:00:00Z")),"2026-11-01 09");
 assert.equal(officeSlot(new Date("2026-11-01T13:00:00Z")),null);
});

test("office output validation needs the required fields, ignores extras, bounds text, and escapes mass mentions",()=>{
 const open={message:"Agenda",notebook:"Next"};
 assert.deepEqual(strictOfficeResult(open,"chief:open"),open);
 assert.deepEqual(strictOfficeResult({...open,extra:"no"},"chief:open"),open);
 assert.equal(strictOfficeResult({message:"Agenda"},"chief:open"),null);
 const work={message:"Evidence",proposals_json:'[{"title":"Try","why":"Why","effort":"Small"}]',notebook:"Next",texture_prompts:[]};
 assert.equal(strictOfficeResult(work,"growth:discuss").message,"Evidence");
 assert.equal(strictOfficeResult({...work,extra:true},"growth:work").message,"Evidence");
 // Draft proposals live in a free-text JSON string, so their shape is forgiving (the live Studio turn was rejected over this).
 assert.equal(strictOfficeResult({...work,proposals_json:'[{"title":"Palette v1","why":"Warmer","owner":"Studio"}]'},"studio:work").proposals[0].title,"Palette v1");
 assert.deepEqual(strictOfficeResult({...work,proposals_json:"not json"},"studio:work").proposals,[]);
 assert.equal(strictOfficeResult({notebook:"x",proposals_json:"[]",texture_prompts:[]},"growth:work"),null);
 assert.equal(strictOfficeResult({...work,message:"x".repeat(700)},"growth:discuss").message.length,600);
 assert.equal(escapeMentions("@everyone @here"),"@\u200beveryone @\u200bhere");
});
