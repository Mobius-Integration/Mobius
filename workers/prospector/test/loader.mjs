import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const TEXT_ASSETS = /\.(?:svg|axe\.min\.js)$/i;

registerHooks({ load(url, context, nextLoad) {
  if (url === "cloudflare:email") return { format: "module", shortCircuit: true, source: "export class EmailMessage {}" };
  if (url.startsWith("file:") && TEXT_ASSETS.test(new URL(url).pathname)) {
    return { format: "module", shortCircuit: true, source: `export default ${JSON.stringify(readFileSync(new URL(url), "utf8"))};` };
  }
  return nextLoad(url, context);
} });
