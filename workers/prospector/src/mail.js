// The only way this Worker sends mail. The recipient is never a parameter: it is env.FOUNDER_TO.

import { EmailMessage } from "cloudflare:email";
import { buildMime } from "../../shared/mime.js";

export async function sendToFounder(env, subject, text, html) {
  const to = env.FOUNDER_TO;
  if (typeof to !== "string" || !/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(to) || to.length > 254) {
    throw new Error("FOUNDER_TO secret is not set to a single valid address; refusing to send");
  }
  if (!env.FROM_ADDRESS) throw new Error("FROM_ADDRESS is not set");
  const raw = buildMime({
    from: `"Mobius prospects" <${env.FROM_ADDRESS}>`,
    to,
    replyTo: env.OPS_ADDRESS,
    subject,
    text,
    html,
    domain: env.FROM_ADDRESS.split("@")[1],
  });
  const toHeader = /^To: (.*)$/m.exec(raw);
  if (!toHeader || toHeader[1].trim().toLowerCase() !== to.toLowerCase()) throw new Error("recipient mismatch; refusing to send");
  await env.MAILER.send(new EmailMessage(env.FROM_ADDRESS, to, raw));
}
