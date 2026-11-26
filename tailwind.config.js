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
          '"Plus Jakarta Sans"',
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
          50:  "#f5e9e1",
          100: "#ead2c2",
          200: "#d9b29a",
          300: "#c68c6b",
          400: "#b66a49",
          500: "#a94e32",
          600: "#963c27",
          700: "#7c3022",
          800: "#65291f",
          900: "#51231c"
        }
      }
    }
  },
  plugins: [
    require('@tailwindcss/typography')
  ]
};
