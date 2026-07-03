import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import type { City } from "../lib/types";

interface HeaderProps {
  city: City | null;
  theme: "dark" | "light";
  onCityClick: () => void;
  onThemeToggle: () => void;
}

export function Header({
  city,
  theme,
  onCityClick,
  onThemeToggle,
}: HeaderProps) {
  const { user } = useAuth();
  const navigate = useNavigate();

  return (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <Link to="/" className="group">
        <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
          <span
            aria-hidden
            className="mr-2 inline-block text-marigold transition-transform duration-500 group-hover:rotate-180"
          >
            ✦
          </span>
          Northstar Nomad
        </h1>
        <p className="mt-1 text-sm text-muted">
          Your free weekends, already planned.
        </p>
      </Link>

      <div className="flex items-center gap-2">
        <button
          onClick={onCityClick}
          className="rounded-full bg-deep px-3 py-1.5 font-numeric text-xs uppercase tracking-widest text-muted ring-1 ring-raise transition hover:text-starlight"
        >
          {city ? `${city.emoji} ${city.name}` : "📍 Pick your city"} ▾
        </button>
        <button
          onClick={() => navigate(user ? "/profile" : "/login")}
          className="flex items-center gap-1.5 rounded-full bg-deep px-3 py-1.5 text-sm text-muted ring-1 ring-raise transition hover:text-starlight"
        >
          {user ? (
            <>
              <span className="grid h-5 w-5 place-items-center rounded-full bg-marigold font-numeric text-[10px] font-bold text-ink">
                {user.name.charAt(0).toUpperCase()}
              </span>
              {user.name.split(" ")[0]}
            </>
          ) : (
            <>👤 Sign in</>
          )}
        </button>
        <button
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          onClick={onThemeToggle}
          className="grid h-9 w-9 place-items-center rounded-full bg-deep ring-1 ring-raise transition hover:rotate-12 hover:text-starlight"
        >
          {theme === "dark" ? "☀️" : "🌙"}
        </button>
      </div>
    </header>
  );
}
