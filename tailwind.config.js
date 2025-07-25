module.exports = {
  content: [
    "./src/**/*.njk",
    "./src/**/*.md",
    "./src/**/*.html"
  ],
  theme: {
    extend: {
      colors: {
        // Example custom colors (optional):
        indigo: {
          50:  "#f5f3ff",
          100: "#e0e7ff",
          200: "#c7d2fe",
          300: "#a5b4fc",
          400: "#818cf8",
          500: "#6366f1",
          600: "#4f46e5",
          700: "#4338ca",
          800: "#3730a3",
          900: "#312e81"
        }
        // You can add other brand colors or a custom 'rainbow' gradient config if needed
      }
    }
  },
  plugins: [
    require('@tailwindcss/typography'),   // for styling blog content (optional)
    // require('@tailwindcss/forms')      // optional: better base styles for <form> elements
  ]
};
