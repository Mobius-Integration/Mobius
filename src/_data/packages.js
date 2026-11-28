// Every package and price on the site renders from this file.
// Change a price or an inclusion here and it updates everywhere.
// Keep this file free of CSS class names (Tailwind does not scan it).

const oneTime = [
  {
    id: "checkup",
    name: "Free Tech Checkup",
    price: "Free",
    priceNote: "20-minute call + written report",
    tagline: "See what is working and what could be improved before deciding what to do next.",
    bestFor: "Any local business that isn't sure where to start.",
    includes: [
      "Mobile and speed check of your website",
      "Accessibility scan of your key pages",
      "Test of your booking or contact flow, start to finish",
      "Review of your Google Business Profile",
      "Plain-English report with your top fixes, ranked"
    ],
    timeline: "Report within 3 business days of the call",
    cta: { label: "Book my free checkup", href: "/free-checkup/" },
    featured: false
  },
  {
    id: "tuneup",
    name: "Website & Accessibility Tune-Up",
    price: "From $497",
    priceNote: "$497 fix plan, or from $997 done for you",
    tagline: "Fix the problems visitors and automated scanners find on the site you already have.",
    bestFor: "Businesses with an existing website that's hard to use or flagged in a checkup.",
    includes: [
      "Fix Plan ($497): step-by-step fixes your own web team can follow, in priority order",
      "Written requests to your vendors for the parts only they can fix",
      "An accessibility statement that matches what's true about your site",
      "A 30-minute handoff with your web team, and one re-test within 60 days",
      "Done for you (from $997): we make the fixes, including a keyboard and screen-reader pass on your booking or contact flow",
      "Before-and-after report you can keep on file"
    ],
    timeline: "Fix Plan in 5 business days; fixes typically 1 week",
    cta: { label: "Start with a free checkup", href: "/free-checkup/" },
    featured: false,
    finePrint:
      "The Fix Plan fee is credited in full if you have us make the fixes within 30 days. We fix and document what we find against WCAG 2.1 AA. We are not a law firm, and no one can honestly guarantee legal compliance."
  },
  {
    id: "sprint",
    name: "48-Hour Automation Sprint",
    price: "$997",
    priceNote: "one-time",
    tagline: "Set up timely replies and reminders, including follow-up after a missed appointment.",
    bestFor: "Appointment-based businesses: practices, salons, studios, home services.",
    includes: [
      "Instant auto-reply to new inquiries by text and email",
      "Online booking with confirmations",
      "Reminder sequences before every appointment",
      "No-show recovery that offers a new time automatically",
      "Review requests after each visit",
      "Win-back campaign for customers you haven't seen in months"
    ],
    timeline: "Live 48 hours after you give us access",
    cta: { label: "Book a free checkup first", href: "/free-checkup/" },
    featured: true
  },
  {
    id: "launch",
    name: "Website Launch",
    price: "From $1,497",
    priceNote: "one-time",
    tagline: "A fast, modern site that works on every phone and for every visitor.",
    bestFor: "New businesses, or a site that's too old to be worth fixing.",
    includes: [
      "Up to 5 pages, written and designed for you",
      "Built mobile-first and to WCAG 2.1 AA accessibility standards",
      "Domain, DNS and business email set up",
      "Contact or booking form that reaches you",
      "Google Business Profile set up or cleaned up"
    ],
    timeline: "Typically 2 weeks",
    cta: { label: "Talk through your site", href: "/contact/" },
    featured: false
  },
  {
    id: "custom",
    name: "Custom Tools & AI",
    price: "Custom quote",
    priceNote: "fixed price after a free scoping call",
    tagline: "When off-the-shelf software doesn't fit how you work.",
    bestFor: "Teams spending time moving information between spreadsheets and disconnected systems.",
    includes: [
      "AI assistants trained on your own documents and FAQs",
      "Connections between your booking, POS, CRM and accounting tools",
      "Internal dashboards and reports",
      "Automation of repetitive back-office work",
      "A fixed quote before any work starts"
    ],
    timeline: "Scoped per project",
    cta: { label: "Describe your problem", href: "/contact/" },
    featured: false
  }
];

const monthly = [
  {
    id: "partner",
    name: "Tech Partner",
    price: "$297",
    priceNote: "per month",
    tagline: "One team that keeps your tech working, so you don't have to think about it.",
    bestFor: "Businesses that want someone to call instead of five different vendors.",
    includes: [
      "Monthly health check: site, forms, booking and accessibility",
      "Your automations monitored and tuned",
      "Up to 2 hours of changes each month",
      "Replies within one business day",
      "Monthly report in plain English"
    ],
    cta: { label: "Ask about Tech Partner", href: "/contact/" },
    featured: true
  },
  {
    id: "partner-plus",
    name: "Tech Partner Plus",
    price: "$597",
    priceNote: "per month",
    tagline: "For businesses that are actively growing and changing things every month.",
    bestFor: "Multi-location businesses or teams with ongoing projects.",
    includes: [
      "Everything in Tech Partner",
      "Up to 6 hours of changes each month",
      "Quarterly planning session",
      "Front of the queue for requests",
      "Help managing your other tech vendors"
    ],
    cta: { label: "Ask about Plus", href: "/contact/" },
    featured: false
  }
];

module.exports = {
  oneTime,
  monthly,
  all: [...oneTime, ...monthly],
  terms: [
    "Monthly plans are month-to-month. No long-term contract.",
    "Every project gets a fixed price in writing before work starts.",
    "Third-party software fees (for example texting or booking tools) are billed at cost and quoted up front."
  ]
};
