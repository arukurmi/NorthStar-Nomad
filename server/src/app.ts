import express, { type Express } from "express";
import cors, { type CorsOptions } from "cors";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { calendarRouter } from "./routes/calendar.js";
import { recommendationsRouter } from "./routes/recommendations.js";
import { authRouter } from "./routes/auth.js";
import { tripsRouter } from "./routes/trips.js";
import { aiKeysRouter } from "./routes/ai-keys.js";

/**
 * `cors()` with no arguments answers `Access-Control-Allow-Origin: *`, which
 * lets a page on any domain call `/api/ai/keys` with a token it lifted from a
 * victim. Deployed, this process serves `web/dist` itself, so the browser needs
 * no cross-origin permission at all — production defaults to none and
 * `NOMAD_WEB_ORIGIN` (comma-separated) opts specific origins back in. In
 * development it stays permissive so Vite on :5173 can talk to :4000.
 */
export function corsOptions(env: NodeJS.ProcessEnv = process.env): CorsOptions {
  const configured = (env.NOMAD_WEB_ORIGIN ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (configured.length > 0) return { origin: configured };
  // `origin: false` sends no CORS header; `true` reflects the caller's origin,
  // which is narrower than "*" and works with credentialed requests.
  return { origin: env.NODE_ENV !== "production" };
}

export function createApp(): Express {
  const app = express();
  app.use(cors(corsOptions()));
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use(calendarRouter);
  app.use(recommendationsRouter);
  app.use(authRouter);
  app.use(tripsRouter);
  app.use(aiKeysRouter);

  // In production the API server also serves the built frontend (SPA).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.resolve(here, "../../web/dist");
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api")) {
        next();
        return;
      }
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  return app;
}
