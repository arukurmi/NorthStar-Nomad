import { Router } from "express";
import bcrypt from "bcryptjs";
import { db } from "../db.js";
import { requireAuth, signToken, type AuthedRequest } from "../auth/tokens.js";

interface UserRow {
  id: number;
  name: string;
  email: string;
  password_hash: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(u: UserRow) {
  return { id: u.id, name: u.name, email: u.email };
}

export const authRouter = Router();

authRouter.post("/api/auth/register", (req, res) => {
  const { name, email, password } = req.body ?? {};
  if (
    typeof name !== "string" ||
    name.trim().length < 2 ||
    typeof email !== "string" ||
    !EMAIL_RE.test(email) ||
    typeof password !== "string" ||
    password.length < 8
  ) {
    res.status(400).json({
      error: "need a name, a valid email, and a password of 8+ characters",
    });
    return;
  }
  const normalized = email.trim().toLowerCase();
  const existing = db
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(normalized);
  if (existing) {
    res.status(409).json({ error: "an account with this email already exists" });
    return;
  }
  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)")
    .run(name.trim(), normalized, hash);
  const user = db
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(info.lastInsertRowid) as UserRow;
  res.status(201).json({ token: signToken(user.id), user: publicUser(user) });
});

authRouter.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "email and password required" });
    return;
  }
  const user = db
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(email.trim().toLowerCase()) as UserRow | undefined;
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    res.status(401).json({ error: "wrong email or password" });
    return;
  }
  res.json({ token: signToken(user.id), user: publicUser(user) });
});

authRouter.get("/api/auth/me", requireAuth, (req: AuthedRequest, res) => {
  const user = db
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(req.userId) as UserRow | undefined;
  if (!user) {
    res.status(401).json({ error: "account no longer exists" });
    return;
  }
  res.json({ user: publicUser(user) });
});
