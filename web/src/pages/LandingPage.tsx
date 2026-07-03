import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

/** Deterministic pseudo-random star positions — same sky every visit. */
const STARS = Array.from({ length: 28 }, (_, i) => {
  const seed = (i * 2654435761) % 4294967296;
  return {
    left: `${(seed % 97) + 1}%`,
    top: `${((seed >> 8) % 88) + 2}%`,
    size: 2 + ((seed >> 16) % 3),
    delay: `${((seed >> 20) % 30) / 10}s`,
  };
});

const WEEK = ["M", "T", "W", "T", "F", "S", "S"];

function Reveal({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => entry.isIntersecting && setShown(true),
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`transition-all duration-700 ease-out ${
        shown ? "translate-y-0 opacity-100" : "translate-y-8 opacity-0"
      } ${className}`}
    >
      {children}
    </div>
  );
}

const MODES = [
  {
    emoji: "✈️",
    title: "Flight trips",
    body: "The far-away pick — Goa in December, the Andamans in January, Bali when the dry season hits.",
    tint: "ring-sky/40 hover:shadow-[0_0_40px_rgba(122,167,255,0.15)]",
  },
  {
    emoji: "🏍️",
    title: "Bike trips",
    body: "Rides sized to your city — Lansdowne before breakfast from Delhi, Goa by lunch from Mumbai.",
    tint: "ring-jade/40 hover:shadow-[0_0_40px_rgba(56,209,165,0.15)]",
  },
  {
    emoji: "🚌",
    title: "Bus, with friends",
    body: "The overnight-Volvo classics — Manali, McLeod Ganj, Jaipur — planned before the group chat argues.",
    tint: "ring-marigold/40 hover:shadow-[0_0_40px_rgba(255,182,72,0.15)]",
  },
];

export function LandingPage() {
  return (
    <main className="relative overflow-hidden">
      {/* Ambient sky: drifting aurora + twinkling stars, pure CSS. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-32 left-1/4 h-[28rem] w-[28rem] animate-drift rounded-full bg-gradient-to-br from-sky/20 via-jade/10 to-transparent blur-3xl" />
        <div className="absolute right-0 top-40 h-[22rem] w-[22rem] animate-drift rounded-full bg-gradient-to-bl from-rose/15 via-marigold/10 to-transparent blur-3xl [animation-delay:-12s]" />
        {STARS.map((s, i) => (
          <span
            key={i}
            className="absolute animate-twinkle rounded-full bg-starlight"
            style={{
              left: s.left,
              top: s.top,
              width: s.size,
              height: s.size,
              animationDelay: s.delay,
            }}
          />
        ))}
      </div>

      {/* Hero */}
      <section className="flex min-h-[70vh] flex-col items-center justify-center py-20 text-center">
        <span
          aria-hidden
          className="animate-star-pulse font-display text-5xl text-marigold"
        >
          ✦
        </span>
        <h2 className="mt-6 font-display text-5xl font-bold leading-tight tracking-tight sm:text-7xl">
          <span className="block animate-fade-up">Your free weekends,</span>
          <span className="block animate-fade-up bg-gradient-to-r from-marigold via-rose to-sky bg-clip-text text-transparent [animation-delay:0.25s]">
            already planned.
          </span>
        </h2>
        <p className="mt-6 max-w-xl animate-fade-up text-lg text-muted [animation-delay:0.5s]">
          A calendar that spots your long weekends before you do — and fills
          them with the right trip for the weather, your city, and your budget.
        </p>

        {/* Signature: the week constellation. Weekends glow, a line connects them. */}
        <div className="relative mt-12 animate-fade-up [animation-delay:0.8s]">
          <div className="flex items-center gap-3 sm:gap-5">
            {WEEK.map((d, i) => {
              const weekend = i >= 5;
              return (
                <span
                  key={i}
                  className={`grid h-10 w-10 place-items-center rounded-full font-numeric text-sm sm:h-12 sm:w-12 ${
                    weekend
                      ? "bg-marigold/15 font-bold text-marigold ring-1 ring-marigold shadow-star"
                      : "bg-deep/80 text-muted ring-1 ring-raise"
                  }`}
                >
                  {d}
                </span>
              );
            })}
          </div>
          <span
            aria-hidden
            className="absolute -right-1 top-1/2 hidden h-px w-[104px] -translate-y-1/2 animate-constellation-draw border-t border-dotted border-marigold/80 sm:block"
            style={{ right: "-2px", maxWidth: "116px" }}
          />
        </div>

        <div className="mt-12 flex animate-fade-up flex-wrap justify-center gap-3 [animation-delay:1.1s]">
          <Link
            to="/app"
            className="rounded-full bg-marigold px-7 py-3 font-semibold text-ink shadow-star transition hover:scale-105 hover:brightness-110"
          >
            Open the calendar →
          </Link>
          <Link
            to="/login"
            className="rounded-full bg-deep px-7 py-3 font-semibold text-starlight ring-1 ring-raise transition hover:scale-105 hover:ring-marigold/60"
          >
            Save your trips
          </Link>
        </div>
      </section>

      {/* Three ways out of town */}
      <section className="mx-auto max-w-4xl pb-20">
        <Reveal>
          <p className="text-center font-numeric text-xs font-bold uppercase tracking-[0.3em] text-muted">
            Every free window · three ways out of town
          </p>
        </Reveal>
        <div className="mt-8 grid gap-5 sm:grid-cols-3">
          {MODES.map((m, i) => (
            <Reveal key={m.title} className={i === 1 ? "sm:translate-y-6" : ""}>
              <div
                className={`h-full rounded-card bg-deep/80 p-6 ring-1 transition-all duration-300 hover:-translate-y-1 ${m.tint}`}
              >
                <span aria-hidden className="text-3xl">
                  {m.emoji}
                </span>
                <h3 className="mt-3 font-display text-lg font-semibold">
                  {m.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  {m.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal className="mt-16">
          <div className="rounded-card bg-gradient-to-r from-deep via-raise to-deep p-8 text-center ring-1 ring-white/5">
            <p className="font-display text-2xl font-semibold">
              It knows Goa is a mistake in July.
            </p>
            <p className="mx-auto mt-3 max-w-lg text-sm text-muted">
              Every destination carries a 12-month weather profile. Monsoon
              picks sit out the monsoon, Ladakh waits for its passes to open,
              and a 2-day weekend never gets a 6-day trip.
            </p>
            <Link
              to="/app"
              className="mt-6 inline-block rounded-full bg-marigold/15 px-6 py-2.5 font-semibold text-marigold ring-1 ring-marigold/50 transition hover:bg-marigold/25"
            >
              Find my next trip ✦
            </Link>
          </div>
        </Reveal>
      </section>
    </main>
  );
}
