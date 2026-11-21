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

// Gmail's iPhone and iPad app. A plain mailto: opens Apple Mail there unless Gmail is the default mail app.
export function gmailIosUrl({ to, bcc, subject, body }) {
  const q = [];
  if (to) q.push(`to=${enc(to)}`);
  if (bcc) q.push(`bcc=${enc(bcc)}`);
  q.push(`subject=${enc(subject)}`, `body=${enc(body)}`);
  return `googlegmail:///co?${q.join("&")}`;
}

// Gmail's Android app: a Chrome intent that hands the mailto: straight to Gmail instead of asking which app.
export function gmailAndroidUrl({ to, bcc, subject, body }) {
  return mailtoUrl({ to, bcc, subject, body }).replace(/^mailto:/, "intent:") + "#Intent;scheme=mailto;package=com.google.android.gm;end";
}

export function composeLinks(env, { to, subject, body }) {
  const m = { to, bcc: env.OPS_ADDRESS || "", subject, body };
  return {
    gmail: gmailUrl({ ...m, account: env.FOUNDER_TO }),
    ios: gmailIosUrl(m),
    android: gmailAndroidUrl(m),
    mailto: mailtoUrl(m),
  };
}

// "ios", "android" or "desktop", from the browser's User-Agent.
export function platformOf(userAgent) {
  const ua = String(userAgent || "");
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "desktop";
}

// The "Write in Gmail" link for this device: the Gmail app on a phone, Gmail on the web on a computer.
export function writeLink(links, platform) {
  if (platform === "ios") return { href: links.ios, newTab: false };
  if (platform === "android") return { href: links.android, newTab: false };
  return { href: links.gmail, newTab: true };
}
