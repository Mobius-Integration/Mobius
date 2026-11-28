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
          '"DM Sans"',
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
          '"Baloo 2"',
          "ui-sans-serif",
          "system-ui",
          "sans-serif"
        ]
      },
      colors: {
        gray: {
          50: "#F1FBFB", 100: "#FFFBF0", 200: "#DDF7F7", 300: "#b9dada",
          400: "#85859a", 500: "#66667f", 600: "#4A4A66", 700: "#4A4A66",
          800: "#1B1B3A", 900: "#1B1B3A"
        },
        gulf: {
          50: "#DDF7F7", 100: "#DDF7F7", 200: "#00A0A4", 300: "#00A0A4",
          400: "#007E82", 500: "#007E82", 600: "#007E82", 700: "#007E82",
          800: "#00686b", 900: "#00585b"
        },
        sand: {
          50: "#FFF4C2", 100: "#FFD447", 200: "#FFD447", 300: "#9A7000", 400: "#6b4e00"
        }
      }
    }
  },
  plugins: [
    require('@tailwindcss/typography')
  ]
};
