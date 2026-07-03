import { MonthGrid } from "./components/Calendar/MonthGrid";

export default function App() {
  const now = new Date();
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-8">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
            <span aria-hidden className="mr-2 text-marigold">
              ✦
            </span>
            Northstar Nomad
          </h1>
          <p className="mt-1 text-sm text-muted">
            Your free weekends, already planned.
          </p>
        </div>
        <p className="hidden font-numeric text-xs uppercase tracking-widest text-muted sm:block">
          from Delhi-NCR
        </p>
      </header>

      <main className="mt-8">
        <MonthGrid year={now.getFullYear()} month={now.getMonth() + 1} />
      </main>
    </div>
  );
}
