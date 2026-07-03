import { Link } from "react-router-dom";

export function LandingPage() {
  return (
    <main className="mt-24 text-center">
      <h2 className="font-display text-5xl font-bold">
        Your free weekends, already planned.
      </h2>
      <Link
        to="/app"
        className="mt-8 inline-block rounded-full bg-marigold px-6 py-3 font-semibold text-ink"
      >
        Open the calendar →
      </Link>
    </main>
  );
}
