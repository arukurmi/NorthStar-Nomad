/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "rgb(var(--c-ink) / <alpha-value>)",
        deep: "rgb(var(--c-deep) / <alpha-value>)",
        raise: "rgb(var(--c-raise) / <alpha-value>)",
        starlight: "rgb(var(--c-text) / <alpha-value>)",
        muted: "rgb(var(--c-muted) / <alpha-value>)",
        marigold: "#FFB648",
        rose: "#F4647D",
        jade: "#38D1A5",
        sky: "#7AA7FF",
      },
      fontFamily: {
        display: ['"Bricolage Grotesque"', "system-ui", "sans-serif"],
        body: ['"Instrument Sans"', "system-ui", "sans-serif"],
        numeric: ['"Space Grotesk"', "monospace"],
      },
      boxShadow: {
        star: "0 0 12px 2px rgba(255, 182, 72, 0.35)",
        "star-soft": "0 0 8px 1px rgba(255, 182, 72, 0.2)",
        drawer: "-24px 0 60px rgba(6, 9, 24, 0.6)",
      },
      borderRadius: {
        card: "1.25rem",
      },
      keyframes: {
        fadeUp: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-up": "fadeUp 0.35s ease-out both",
      },
    },
  },
  plugins: [],
};
