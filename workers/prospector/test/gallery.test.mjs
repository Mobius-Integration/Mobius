import test from "node:test";
import assert from "node:assert/strict";
import { allowRequest, wrapMockup, renderMockup } from "../src/gallery.js";

test("mockups may only load Google Fonts and data URLs", () => {
  assert.equal(allowRequest("https://fonts.googleapis.com/css2?family=Inter"), true);
  assert.equal(allowRequest("https://fonts.gstatic.com/s/inter.woff2"), true);
  assert.equal(allowRequest("data:image/png;base64,AA"), true);
  assert.equal(allowRequest("https://evil.example/track.png"), false);
  assert.equal(allowRequest("https://fonts.googleapis.com.evil.example/x"), false);
});

test("mockup HTML has scripts stripped and a strict CSP", () => {
  const out = wrapMockup('<h1>Hi</h1><script>alert(1)</script><script src="x.js">');
  assert.ok(!/<script/i.test(out));
  assert.match(out, /default-src 'none'/);
  assert.match(out, /<h1>Hi<\/h1>/);
});

test("renderMockup turns JS off and blocks other hosts", async () => {
  const calls = [];
  const page = {
    setJavaScriptEnabled: async (v) => calls.push(["js", v]),
    setRequestInterception: async (v) => calls.push(["intercept", v]),
    on: (ev, fn) => { const r = (u) => ({ url: () => u, continue: () => calls.push(["ok", u]), abort: () => calls.push(["blocked", u]) }); fn(r("https://evil.example/a.png")); fn(r("https://fonts.gstatic.com/a.woff2")); },
    setViewport: async () => {}, setContent: async () => {}, evaluate: async () => 900,
    screenshot: async (o) => { calls.push(["shot", o.clip.height]); return new Uint8Array([1, 2, 3]); },
  };
  const png = await renderMockup({}, "<p>x</p>", { launch: async () => ({ newPage: async () => page, close: async () => {} }) });
  assert.deepEqual([...png], [1, 2, 3]);
  assert.deepEqual(calls.find((c) => c[0] === "js"), ["js", false]);
  assert.ok(calls.some((c) => c[0] === "blocked" && c[1].includes("evil")));
  assert.ok(calls.some((c) => c[0] === "ok" && c[1].includes("gstatic")));
});
