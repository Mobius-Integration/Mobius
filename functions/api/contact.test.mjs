import test from "node:test";
import assert from "node:assert/strict";
import { classifyPitch, isBotTrap } from "./contact.js";

const owner = {
  name: "Local owner",
  email: "owner@example.com",
  business: "Bay Area Salon",
  site_url: "https://bayareasalon.com",
  message: "I'd like a free write-up of my booking page.",
};

test("bot traps catch a filled honeypot and submissions under three seconds", () => {
  assert.equal(isBotTrap({ mbx_hp: "https://spam.example" }, 10_000), true);
  assert.equal(isBotTrap({ started_at: "8001" }, 10_000), true);
  assert.equal(isBotTrap({ started_at: "7000" }, 10_000), false);
  assert.equal(isBotTrap({ started_at: "11000" }, 10_000), false);
  assert.equal(isBotTrap({ started_at: "" }, 10_000), false);
});

test("flags look-alike and own-domain email addresses", () => {
  assert.equal(classifyPitch({ ...owner, email: "rep@search-mobiusintegration.com" }), true);
  assert.equal(classifyPitch({ ...owner, email: "owner@mobiusintegration.com" }), true);
});

test("flags sales offers referring to Mobius or the recipient's site", () => {
  assert.equal(classifyPitch({ ...owner, message: "Dear Sir/Madam, Register mobiusintegration.com in Google Search today." }), true);
  assert.equal(classifyPitch({ ...owner, message: "Hi http://mobiusintegration.com, I recently visited your website and noticed some SEO errors on your website." }), true);
  assert.equal(classifyPitch({ ...owner, message: "Hi, your website mobiusintegration.com really stood out." }), true);
  assert.equal(classifyPitch({ ...owner, message: "I can help your website get more traffic" }), true);
  assert.equal(classifyPitch({ ...owner, message: "We help businesses with marketing services for your site. Proposal attached." }), true);
});

test("flags a big non-local website and accepts a local owner's write-up request", () => {
  assert.equal(classifyPitch({ ...owner, site_url: "www.bbc.com" }), true);
  assert.equal(classifyPitch(owner), false);
});

test("a submission claiming to be Mobius Integration is a pitch", () => {
  assert.equal(classifyPitch({ ...owner, business: "Mobius Integration" }), true);
});

test("real owners asking for help are never filed as pitches", () => {
  for (const message of [
    "Saw your site, can I get a quote to fix my restaurant website? It's really slow on phones.",
    "I can't find my salon on Google search. I visited mobiusintegration.com, can you help?",
    "Yes please send the free write-up for my dental office. Our site says not secure.",
    "Got your email about my site. What would online booking cost? We get a lot of traffic from Google.",
    "Can you redesign our website? Looking for a proposal and a quote.",
  ]) assert.equal(classifyPitch({ ...owner, message }), false, message);
});
