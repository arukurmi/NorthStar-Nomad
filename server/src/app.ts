import express, { type Express } from "express";
import cors from "cors";
import { calendarRouter } from "./routes/calendar.js";
import { recommendationsRouter } from "./routes/recommendations.js";

export function createApp(): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use(calendarRouter);
  app.use(recommendationsRouter);

  return app;
}
