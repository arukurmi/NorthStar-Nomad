import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { looksDeployed } from "../ai/vault.js";

/**
 * The signing secret every non-production process falls back to. Public on
 * purpose, exactly like DEV_MASTER_KEY: it lives in git, so anyone with this
 * repo can mint a token for any user id. Production refuses to boot with it —
 * a forgeable session is a master key for the whole vault, because every AI
 * route is reachable with nothing but a bearer token.
 */
export const DEV_JWT_SECRET = "northstar-dev-secret-change-in-production";
const MIN_JWT_SECRET_LENGTH = 32;
const TOKEN_TTL = "30d";

const JWT_MISSING_MSG = "JWT_SECRET is required when NODE_ENV=production.";
const JWT_SHORT_MSG = `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters when NODE_ENV=production.`;
const JWT_DEV_IN_PROD_MSG =
  "JWT_SECRET contains the built-in development secret, which is public — refusing to use it on a production or deployed host.";

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

/** Pure, injectable core — mirrors `resolveMasterKey`. */
export function resolveJwtSecret(env: NodeJS.ProcessEnv): string {
  const raw = env.JWT_SECRET?.trim();
  // Same rule as the vault: a platform marker means deployed, whatever
  // NODE_ENV says, and a deployed host may not sign tokens with a public value.
  const isProd = env.NODE_ENV === "production" || looksDeployed(env);

  if (isProd) {
    if (!raw) throw new AuthConfigError(JWT_MISSING_MSG);
    if (raw.toLowerCase().includes(DEV_JWT_SECRET)) {
      throw new AuthConfigError(JWT_DEV_IN_PROD_MSG);
    }
    if (raw.length < MIN_JWT_SECRET_LENGTH) {
      throw new AuthConfigError(JWT_SHORT_MSG);
    }
    return raw;
  }

  return raw || DEV_JWT_SECRET;
}

let jwtSecret: string | null = null;

/** Resolves and memoises the signing secret. Throws AuthConfigError in prod. */
export function getJwtSecret(): string {
  jwtSecret ??= resolveJwtSecret(process.env);
  return jwtSecret;
}

/** Drops the memoised secret. Test-only, mirrors the vault's escape hatch. */
export function __resetJwtSecretForTests(): void {
  jwtSecret = null;
}

/**
 * Called from index.ts alongside `assertVaultConfigured`. Exits(1) in
 * production rather than serving forgeable sessions.
 */
export function assertAuthConfigured(): void {
  try {
    getJwtSecret();
  } catch (err) {
    if (!(err instanceof AuthConfigError)) throw err;
    process.stderr.write(
      `FATAL: ${err.message}\n` +
        "It signs every session token; a guessable one lets anyone mint a\n" +
        "session for any account and read that account's AI keys.\n" +
        "Generate one with:  openssl rand -base64 48\n" +
        "Then set it in the environment and restart. Refusing to start.\n",
    );
    process.exit(1);
  }
}

export function signToken(userId: number): string {
  return jwt.sign({ sub: String(userId) }, getJwtSecret(), {
    expiresIn: TOKEN_TTL,
  });
}

export interface AuthedRequest extends Request {
  userId?: number;
}

/**
 * Rejects with 401 unless a valid Bearer token is present.
 *
 * The body carries `code: "unauthenticated"` because the AI routes answer 401
 * for a second, unrelated reason — the *provider* rejected a pasted API key —
 * and a client that cannot tell the two apart would sign the user out of the
 * whole product over a typo. Additive: existing callers read only the status.
 */
export function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "sign in to do that", code: "unauthenticated" });
    return;
  }
  try {
    const payload = jwt.verify(token, getJwtSecret());
    if (typeof payload === "object" && payload.sub) {
      req.userId = Number(payload.sub);
      next();
      return;
    }
  } catch {
    // fall through to 401
  }
  res
    .status(401)
    .json({ error: "session expired — sign in again", code: "unauthenticated" });
}
