import express, { type Express } from "express";
import cors from "cors";
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

  return app;
}
