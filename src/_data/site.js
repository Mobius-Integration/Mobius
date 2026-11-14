// Single source of truth for site-wide facts. Templates read these as `site.*`.
// PRODUCTION_URL is where the site is live today. When a custom domain is connected,
// change it here (or set SITE_URL at build time) and canonical links and the sitemap follow.
// CONTACT_EMAIL stays empty until a working mailbox exists, so no dead address is published.
const PRODUCTION_URL = "https://mobius-dq3.pages.dev";
const url = (process.env.SITE_URL || PRODUCTION_URL).replace(/\/+$/, "");

module.exports = {
  title: "Mobius Integration",
  tagline: "Your local business tech partner",
  description:
    "Mobius Integration is a Tampa Bay tech partner for local businesses: websites, accessibility fixes, booking and follow-up automation, Google presence, and custom AI tools, in fixed-price packages.",
  url, // "" until a real URL is set; templates must omit canonical/absolute links when empty
  email: process.env.CONTACT_EMAIL || "", // "" hides every mailto link; the contact form is the primary channel
  region: "Tampa Bay",
  areas: ["Tampa", "St. Petersburg", "Clearwater"],
  responseTime: "one business day",
  callHours: "Evening and weekend calls available",
  founders: [
    { name: "Mario Barillas", role: "Founder & CEO" },
    { name: "Eduardo Molina", role: "Co-Founder & Partner" }
  ],
  nav: [
    { label: "Services", href: "/services/" },
    { label: "Packages", href: "/pricing/" },
    { label: "Who We Serve", href: "/industries/" },
    { label: "Examples", href: "/portfolio/" },
    { label: "About", href: "/about/" },
    { label: "Blog", href: "/blog/" },
    { label: "Contact", href: "/contact/" }
  ],
  cta: { label: "Free Tech Checkup", href: "/free-checkup/" },
  year: new Date().getFullYear()
};
