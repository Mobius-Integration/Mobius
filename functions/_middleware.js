// One canonical address for the site.
// When CANONICAL_HOST is set (wrangler.toml), requests for the www host and for the
// production pages.dev host get a permanent redirect to https://CANONICAL_HOST, keeping
// path and query. Preview deployments (<hash>.mobius-dq3.pages.dev, preview.…) and the
// form endpoint under /api/ are left alone.

const PRODUCTION_PAGES_HOST = "mobius-dq3.pages.dev";

export async function onRequest(context) {
  const { request, env, next } = context;
  const canonical = ((env && env.CANONICAL_HOST) || "").trim().toLowerCase();
  if (!canonical) return next();

  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  if (host === canonical || url.pathname.startsWith("/api/")) return next();

  if (host === `www.${canonical}` || host === PRODUCTION_PAGES_HOST) {
    url.protocol = "https:";
    url.hostname = canonical;
    url.port = "";
    return Response.redirect(url.toString(), 301);
  }
  return next();
}
