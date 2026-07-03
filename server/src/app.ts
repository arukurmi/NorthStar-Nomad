import express, { type Express } from "express";
import cors from "cors";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { calendarRouter } from "./routes/calendar.js";
import { recommendationsRouter } from "./routes/recommendations.js";
import { authRouter } from "./routes/auth.js";
import { tripsRouter } from "./routes/trips.js";

export function createApp(): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use(calendarRouter);
  app.use(recommendationsRouter);
  app.use(authRouter);
  app.use(tripsRouter);

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
