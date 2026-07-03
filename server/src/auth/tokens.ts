import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";

const JWT_SECRET =
  process.env.JWT_SECRET ?? "northstar-dev-secret-change-in-production";
const TOKEN_TTL = "30d";

export function signToken(userId: number): string {
  return jwt.sign({ sub: String(userId) }, JWT_SECRET, {
    expiresIn: TOKEN_TTL,
  });
}

export interface AuthedRequest extends Request {
  userId?: number;
}

/** Rejects with 401 unless a valid Bearer token is present. */
export function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "sign in to do that" });
    return;
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (typeof payload === "object" && payload.sub) {
      req.userId = Number(payload.sub);
      next();
      return;
    }
  } catch {
    // fall through to 401
  }
  res.status(401).json({ error: "session expired — sign in again" });
}
