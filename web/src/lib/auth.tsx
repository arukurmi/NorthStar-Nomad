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

interface AuthState {
  user: User | null;
  token: string | null;
  register: (name: string, email: string, password: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  /** fetch with the Bearer token attached; throws on non-2xx. */
  authFetch: <T>(url: string, init?: RequestInit) => Promise<T>;
}

const TOKEN_KEY = "nomad-token";
const USER_KEY = "nomad-user";

const AuthContext = createContext<AuthState | null>(null);

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (body as { error?: string }).error ?? `request failed (${res.status})`,
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
    async <T,>(url: string, init: RequestInit = {}): Promise<T> => {
      const res = await fetch(url, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (res.status === 401) {
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
