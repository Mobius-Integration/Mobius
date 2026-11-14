/**
 * .eleventy.js — master configuration for Eleventy
 * --------------------------------------------------
 * This file exposes a function that Eleventy will execute
 * at startup. The `eleventyConfig` argument lets us hook
 * into Eleventy’s build lifecycle (collections, filters,
 * passthrough‑copy, plugins, etc.).
 */
module.exports = function (eleventyConfig) {
  /* --------------------------------------------------
   * 1. Passthrough copy
   * --------------------------------------------------
   * Copy static assets from `src/assets/` straight into
   * `_site/assets/` without processing.
   */
  eleventyConfig.addPassthroughCopy("src/assets");

  // Cloudflare Pages reads security/cache headers from a `_headers` file at the output root.
  eleventyConfig.addPassthroughCopy({ "src/_headers": "_headers" });

  // A sitemap needs absolute URLs. With no SITE_URL set (see src/_data/site.js), publish none.
  if (!(process.env.SITE_URL || "").trim()) {
    eleventyConfig.ignores.add("src/sitemap.njk");
  }

  /* --------------------------------------------------
   * 2. Custom collections
   * --------------------------------------------------
   * `post` – gather every template tagged `post`, then sort
   * by date (newest first) so the blog index can loop over it.
   */
  eleventyConfig.addCollection("post", (collection) => {
    return collection
      .getFilteredByTag("post")
      .sort((a, b) => b.date - a.date);
  });

  eleventyConfig.addFilter("readableDate", (dateObj) => {
    // UTC so a front-matter date like 2026-11-13 never prints as the day before.
    return new Date(dateObj).toLocaleDateString("en-US", {
      year: "numeric", month: "long", day: "numeric", timeZone: "UTC"
    });
  });

  eleventyConfig.addFilter("isoDate", (dateObj) => {
    return new Date(dateObj).toISOString().slice(0, 10);
  });

  /* --------------------------------------------------
   * 3. Directory structure
   * --------------------------------------------------
   * Tell Eleventy where to look for input templates, where the
   * `_includes` live (partials + layouts), and where the built
   * site should be output.
   */
  return {
    dir: {
      /**
       * Template input directory (everything inside `src/` is
       * considered for processing unless excluded in `.gitignore`)
       */
      input: "src",

      /**
       * The `_includes` directory is where Nunjucks partials and
       * layouts live.  Example file: `src/_includes/layouts/base.njk`.
       */
      includes: "_includes",

      /**
       * A convenience alias so that `layout: base` resolves to
       * `src/_includes/layouts/base.njk`.
       */
      layouts: "_includes/layouts",

      /**
       * Data directory (global data files, e.g. `src/_data/site.json`).
       */
      data: "_data",

      /**
       * Output directory (where the finished static site is written).
       */
      output: "_site"
    },
	  // ⬇︎ These two lines make sure .html files get parsed with Nunjucks
  htmlTemplateEngine:  "njk",
  markdownTemplateEngine: "njk",

  // (optional) limit the formats compiled; makes the intent explicit
  templateFormats: ["njk", "md", "html"]
  
  };
};
