import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

export function LoginPage() {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "register") {
        await register(name, email, password);
      } else {
        await login(email, password);
      }
      navigate("/app");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto mt-12 max-w-md animate-fade-up">
      <div className="rounded-card bg-deep p-6 ring-1 ring-white/10 sm:p-8">
        <div className="inline-flex rounded-full bg-ink p-1 font-numeric text-xs uppercase tracking-wide">
          {(["login", "register"] as const).map((m) => (
            <button
              key={m}
              onClick={() => {
                setMode(m);
                setError(null);
              }}
              className={`rounded-full px-4 py-1.5 transition ${
                mode === m
                  ? "bg-marigold font-bold text-ink"
                  : "text-muted hover:text-starlight"
              }`}
            >
              {m === "login" ? "Sign in" : "Create account"}
            </button>
          ))}
        </div>

        <h2 className="mt-5 font-display text-2xl font-bold">
          {mode === "login" ? "Welcome back, nomad" : "Join the nomads"}
        </h2>
        <p className="mt-1 text-sm text-muted">
          {mode === "login"
            ? "Your planned trips are waiting."
            : "Save trips, check in after them, build your travel log."}
        </p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          {mode === "register" && (
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-muted">
                Name
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                minLength={2}
                autoComplete="name"
                className="mt-1 w-full rounded-xl bg-ink px-3 py-2.5 text-starlight ring-1 ring-raise outline-none transition focus:ring-marigold"
              />
            </label>
          )}
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              Email
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              className="mt-1 w-full rounded-xl bg-ink px-3 py-2.5 text-starlight ring-1 ring-raise outline-none transition focus:ring-marigold"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              Password {mode === "register" && "(8+ characters)"}
            </span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === "register" ? 8 : 1}
              autoComplete={
                mode === "register" ? "new-password" : "current-password"
              }
              className="mt-1 w-full rounded-xl bg-ink px-3 py-2.5 text-starlight ring-1 ring-raise outline-none transition focus:ring-marigold"
            />
          </label>

          {error && <p className="text-sm text-rose">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-marigold py-2.5 font-semibold text-ink transition hover:brightness-110 disabled:opacity-60"
          >
            {busy
              ? "One moment…"
              : mode === "login"
                ? "Sign in"
                : "Create my account"}
          </button>
        </form>
      </div>
    </main>
  );
}
