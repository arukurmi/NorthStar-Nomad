import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface User {
  id: number;
  name: string;
  email: string;
}

export interface Trip {
  id: number;
  destination_id: string;
  destination_name: string;
  start: string;
  end: string;
  mode: "flight" | "bike" | "bus";
  status: "planned" | "taken" | "skipped";
}

/** Per-call knobs for {@link AuthState.authFetch}. All optional, all default
 * to the behaviour authFetch had before they existed. */
export interface AuthFetchOptions {
  /**
   * Whether a 401 should clear the stored session.
   *
   * Defaults to `true`, which is right for every route where 401 can only mean
   * "your token is gone". It is *not* right for `POST /api/ai/keys`, where 401
   * also means "the AI provider rejected the API key you just pasted" — signing
   * someone out of Northstar Nomad because they fat-fingered an Anthropic key
   * would be absurd. Those callers pass `false` and branch on the body's
   * `code` instead (`unauthenticated` vs `invalid_key`).
   */
  signOutOn401?: boolean;
}

/**
 * Thrown by `authFetch` on any non-2xx response.
 *
 * `message` is byte-for-byte what the plain `Error` carried before, so every
 * existing `catch` that renders `err.message` is unaffected. `status` and
 * `code` are additive, and let a caller branch on a machine-readable code
 * rather than pattern-matching prose.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly provider?: string;
  readonly retryAfter?: number;

  constructor(
    message: string,
    status: number,
    body: { code?: string; provider?: string; retryAfter?: number } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = body.code;
    this.provider = body.provider;
    this.retryAfter = body.retryAfter;
  }
}

export interface AuthState {
  user: User | null;
  token: string | null;
  register: (name: string, email: string, password: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  /** fetch with the Bearer token attached; throws `ApiError` on non-2xx. */
  authFetch: <T>(
    url: string,
    init?: RequestInit,
    opts?: AuthFetchOptions,
  ) => Promise<T>;
}

const TOKEN_KEY = "nomad-token";
const USER_KEY = "nomad-user";

const AuthContext = createContext<AuthState | null>(null);

interface ErrorShape {
  error?: string;
  code?: string;
  provider?: string;
  retryAfter?: number;
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const shape = body as ErrorShape;
    throw new ApiError(
      shape.error ?? `request failed (${res.status})`,
      res.status,
      shape,
    );
  }
  return body as T;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem(TOKEN_KEY),
  );
  const [user, setUser] = useState<User | null>(() => {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? (JSON.parse(raw) as User) : null;
    } catch {
      return null;
    }
  });

  const persist = (t: string | null, u: User | null) => {
    setToken(t);
    setUser(u);
    if (t && u) {
      localStorage.setItem(TOKEN_KEY, t);
      localStorage.setItem(USER_KEY, JSON.stringify(u));
    } else {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    }
  };

  const register = useCallback(
    async (name: string, email: string, password: string) => {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await jsonOrThrow<{ token: string; user: User }>(res);
      persist(data.token, data.user);
    },
    [],
  );

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await jsonOrThrow<{ token: string; user: User }>(res);
    persist(data.token, data.user);
  }, []);

  const logout = useCallback(() => persist(null, null), []);

  const authFetch = useCallback(
    async <T,>(
      url: string,
      init: RequestInit = {},
      opts: AuthFetchOptions = {},
    ): Promise<T> => {
      const res = await fetch(url, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      // Opt-out, not opt-in: every existing call site omits `opts` and keeps
      // the old "any 401 ends the session" behaviour exactly.
      if (res.status === 401 && opts.signOutOn401 !== false) {
        persist(null, null);
      }
      if (res.status === 204) return undefined as T;
      return jsonOrThrow<T>(res);
    },
    [token],
  );

  // Validate the stored session once on mount.
  useEffect(() => {
    if (!token) return;
    fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => {
        if (res.status === 401) persist(null, null);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo(
    () => ({ user, token, register, login, logout, authFetch }),
    [user, token, register, login, logout, authFetch],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
