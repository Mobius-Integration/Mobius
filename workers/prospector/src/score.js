// Opportunity score, 0-100: how much a quick, friendly offer is likely to help this business.
// `parts` labels are written for a human to read in the digest.

const BOOKING_CATEGORIES = new Set(["restaurants", "dental-medical", "medspa-salon", "fitness", "home-services"]);
const CATEGORY_WEIGHT = { "dental-medical": 10, professional: 10, "medspa-salon": 5, restaurants: 5 };

// prospect: { category, phone }; check: result of checkSite() (ok, ms, metrics) or a failed one.
export function scoreProspect(prospect, check) {
  if (!check || !check.ok) {
    return { total: 0, parts: [["Site didn't load for us (maybe closed or blocking checks), so not pitched", 0]] };
  }
  const m = check.metrics || {};
  const parts = [["Base", 10]];
  if (!m.https) parts.push(["Page doesn't load over HTTPS", 15]);
  // viewport/hasTitle/hasDesc can be null (page cut off before </head>): unknown never scores.
  if (m.viewport === false) parts.push(["No mobile viewport tag", 15]);
  if (m.imgsNoAlt > 0) parts.push([`${m.imgsNoAlt} images without alt text`, Math.min(15, Math.floor(m.imgsNoAlt / 5) * 5)]);
  if (m.fieldsUnlabeled > 0) parts.push([`${m.fieldsUnlabeled} unlabeled form fields`, 10]);
  if (m.noBooking && BOOKING_CATEGORIES.has(prospect.category)) parts.push(["No online booking found", 15]);
  if (check.ms > 3000) parts.push(["Slow first response (over 3 s)", 5]);
  if (m.hasTitle === false || m.hasDesc === false) parts.push(["Missing page title or description", 5]);
  if (prospect.phone) parts.push(["Has a phone number listed", 5]);
  const weight = CATEGORY_WEIGHT[prospect.category];
  if (weight) parts.push([`Business type is a good fit (${prospect.category})`, weight]);

  // "+5 per 5 images" gives 0 for 1-4 images; drop zero-point rows so the breakdown stays honest.
  const shown = parts.filter(([, p]) => p > 0);
  const total = Math.min(100, shown.reduce((s, [, p]) => s + p, 0));
  return { total, parts: shown };
}

// Rebuild the score (and its breakdown) from a stored check row, so the digest can show why.
export function scoreFromRow(row, issues) {
  const has = (re) => issues.some((i) => re.test(i));
  return scoreProspect(row, {
    ok: true,
    ms: row.ms || 0,
    metrics: {
      https: !!row.https, viewport: row.viewport == null ? null : !!row.viewport, imgsNoAlt: row.imgs_no_alt || 0, fieldsUnlabeled: row.fields_unlabeled || 0,
      noBooking: has(/^No online booking/), hasTitle: !has(/^No page title/), hasDesc: !has(/^No meta description/),
    },
  });
}
