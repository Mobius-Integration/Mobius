// Ready-to-send email links. Both carry a hidden copy (Bcc) to the ops address: when the founder sends,
// that copy reaches this Worker's email handler, which marks the prospect as sent. The prospect never
// sees the Bcc.

const enc = (s) => encodeURIComponent(String(s ?? ""));

// Gmail on the web, full-screen compose, in the founder's own Gmail account (authuser).
export function gmailUrl({ to, bcc, subject, body, account }) {
  const q = ["view=cm", "fs=1"];
  if (account) q.push(`authuser=${enc(account)}`);
  if (to) q.push(`to=${enc(to)}`);
  if (bcc) q.push(`bcc=${enc(bcc)}`);
  q.push(`su=${enc(subject)}`, `body=${enc(body)}`);
  return `https://mail.google.com/mail/?${q.join("&")}`;
}

// Any mail app. Inside the Gmail app or Gmail on the web, this opens Gmail's own compose window.
export function mailtoUrl({ to, bcc, subject, body }) {
  const q = [];
  if (bcc) q.push(`bcc=${enc(bcc)}`);
  q.push(`subject=${enc(subject)}`, `body=${enc(body)}`);
  return `mailto:${to ? enc(to).replace(/%40/g, "@") : ""}?${q.join("&")}`;
}

export function composeLinks(env, { to, subject, body }) {
  const bcc = env.OPS_ADDRESS || "";
  return {
    gmail: gmailUrl({ to, bcc, subject, body, account: env.FOUNDER_TO }),
    mailto: mailtoUrl({ to, bcc, subject, body }),
  };
}
