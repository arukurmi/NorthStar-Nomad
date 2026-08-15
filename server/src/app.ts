import express, {
  type ErrorRequestHandler,
  type Express,
} from "express";
import cors, { type CorsOptions } from "cors";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { calendarRouter } from "./routes/calendar.js";
import { recommendationsRouter } from "./routes/recommendations.js";
import { authRouter } from "./routes/auth.js";
import { tripsRouter } from "./routes/trips.js";
import { aiKeysRouter } from "./routes/ai-keys.js";
import { aiPackingRouter } from "./routes/ai-packing.js";

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

/** What body-parser attaches to the errors it throws. */
interface HttpError extends Error {
  type?: string;
  status?: number;
  statusCode?: number;
}

/**
 * Terminal error handler. Without it, Express's finalhandler answers a
 * body-parser failure by writing `err.stack` into the **response** (outside
 * production) and to stderr — and V8 quotes a ~10-character window of the raw
 * body in its parse errors. Verified before this was written: a POST to
 * /api/ai/keys with the body `{"apiKey": AIzaSyCANARY…}` came back 200-odd
 * bytes of HTML containing `..."apiKey": AIzaSyCANA"...`, key material and all,
 * plus absolute paths into node_modules.
 *
 * That path bypasses every AiError guard because the credential never reaches
 * our code — the parser fails first. So: fixed strings only, nothing derived
 * from the request body, ever.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const httpError = err as HttpError;
  const status = httpError.status ?? httpError.statusCode;

  if (httpError.type === "entity.parse.failed") {
    res.status(400).json({
      error: "that request body is not valid JSON",
      code: "bad_request",
    });
    return;
  }
  // The rest of body-parser's failures — entity.too.large, request.aborted,
  // encoding.unsupported. Same rule: the status is safe, the message is not.
  if (httpError.type !== undefined && status !== undefined && status < 500) {
    res.status(status).json({
      error: "that request could not be read",
      code: "bad_request",
    });
    return;
  }

  // A genuine server fault, not something the caller's bytes produced. Its
  // stack is ours and is worth having; the response still says nothing.
  console.error(err instanceof Error ? err.stack : String(err));
  res.status(500).json({ error: "something went wrong", code: "internal" });
};

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
  app.use(aiPackingRouter);

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

  // Last, after every router: an error handler Express only reaches once
  // nothing else has answered.
  app.use(errorHandler);

  return app;
}
