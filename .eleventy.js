module.exports = function (eleventyConfig) {
  // Static assets and Tailwind watcher
  eleventyConfig.addPassthroughCopy("assets");
  eleventyConfig.addWatchTarget("./src/css/");

  // Luxon‑powered date filter (handles JS Date, ISO string, or "now")
  const { DateTime } = require("luxon");
  eleventyConfig.addFilter("date", (value, format = "yyyy") => {
    let dt;
    if (value === "now") {
      dt = DateTime.local();
    } else if (value instanceof Date) {
      dt = DateTime.fromJSDate(value);
    } else {
      dt = DateTime.fromISO(value);
    }
    return dt.isValid ? dt.toFormat(format) : "Invalid date";
  });

  // Case‑study collection
  eleventyConfig.addCollection("case", (collectionApi) => {
    return collectionApi
      .getFilteredByGlob("src/case-studies/*.md")
      .sort((a, b) => b.date - a.date); // newest first
  });

  // Blog posts collection (tag‑based fallback)
  eleventyConfig.addCollection("post", (collectionApi) => {
    return collectionApi
      .getFilteredByGlob("src/posts/*.md")
      .sort((a, b) => b.date - a.date);
  });

  return {
    dir: {
      input: "src",
      includes: "_includes",
      layouts: "_includes/layouts",
      output: "dist",
    },
    templateFormats: ["njk", "md", "html"],
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk",
  };
};
