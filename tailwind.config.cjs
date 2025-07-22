/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "src/**/*.{njk,md,html}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: "#1f809e",
          dark: "#155d70",
        },
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};

