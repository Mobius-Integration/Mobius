module.exports = {
  content: [
    "./src/**/*.njk",
    "./src/**/*.md",
    "./src/**/*.html"
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '"Inter Variable"',
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif"
        ],
        display: [
          '"Inter Variable"',
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Arial",
          "sans-serif"
        ]
      },
      colors: {
        gray: {
          50: "#f4f3ed",
          100: "#e8e7df",
          200: "#d2d2c9",
          300: "#b8b9b0",
          400: "#969b94",
          500: "#727e7d",
          600: "#56666a",
          700: "#405257",
          800: "#293d43",
          900: "#182d34"
        },
        indigo: {
          50:  "#e8f1ee",
          100: "#d4e6df",
          200: "#b3d2c9",
          300: "#8ab9ad",
          400: "#5f9d92",
          500: "#327f77",
          600: "#176a64",
          700: "#115951",
          800: "#124940",
          900: "#123a35"
        }
      }
    }
  },
  plugins: [
    require('@tailwindcss/typography')
  ]
};
