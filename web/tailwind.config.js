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
        slideFromRight: {
          "0%": { opacity: "0", transform: "translateX(32px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        slideFromLeft: {
          "0%": { opacity: "0", transform: "translateX(-32px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        twinkle: {
          "0%, 100%": { opacity: "0.25", transform: "scale(0.85)" },
          "50%": { opacity: "1", transform: "scale(1.15)" },
        },
        drift: {
          "0%": { transform: "translate(-8%, -4%) rotate(0deg)" },
          "50%": { transform: "translate(6%, 5%) rotate(18deg)" },
          "100%": { transform: "translate(-8%, -4%) rotate(0deg)" },
        },
        starPulse: {
          "0%, 100%": {
            textShadow: "0 0 18px rgba(255,182,72,0.9)",
            transform: "scale(1)",
          },
          "50%": {
            textShadow: "0 0 42px rgba(255,182,72,1)",
            transform: "scale(1.12)",
          },
        },
        constellationDraw: {
          "0%": { width: "0" },
          "100%": { width: "100%" },
        },
      },
      animation: {
        "fade-up": "fadeUp 0.35s ease-out both",
        "slide-from-right": "slideFromRight 0.3s ease-out both",
        "slide-from-left": "slideFromLeft 0.3s ease-out both",
        twinkle: "twinkle 3.2s ease-in-out infinite",
        drift: "drift 24s ease-in-out infinite",
        "star-pulse": "starPulse 4s ease-in-out infinite",
        "constellation-draw": "constellationDraw 1.4s ease-out 1.2s both",
      },
    },
  },
  plugins: [],
};
