/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#131A33",
        deep: "#1C2447",
        raise: "#252E58",
        starlight: "#EEF1FF",
        muted: "#9AA3C7",
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
    },
  },
  plugins: [],
};
