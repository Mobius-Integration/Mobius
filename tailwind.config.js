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
          '"Fraunces"',
          "Georgia",
          "Cambria",
          '"Times New Roman"',
          "serif"
        ]
      },
      colors: {
        gray: {
          50: "#dce9e7",
          100: "#f3f1e9",
          200: "#d7e1dc",
          300: "#bdcfc9",
          400: "#82988f",
          500: "#647a70",
          600: "#536a60",
          700: "#435a51",
          800: "#344f46",
          900: "#294b42"
        },
        gulf: {
          50: "#edf4f2",
          100: "#d7e9e6",
          200: "#acd2cc",
          300: "#75b4ad",
          400: "#41988f",
          500: "#247c78",
          600: "#1f716d",
          700: "#1c6965",
          800: "#185d59",
          900: "#144c49"
        },
        sand: {
          50: "#f5ecdb",
          100: "#e8d7b7",
          200: "#cbb58b",
          300: "#a38a58",
          400: "#77643a"
        }
      }
    }
  },
  plugins: [
    require('@tailwindcss/typography')
  ]
};
