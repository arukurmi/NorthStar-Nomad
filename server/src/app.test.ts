import { describe, it, expect } from "vitest";
import request from "supertest";
import { corsOptions, createApp } from "./app.js";

describe("app", () => {
  it("responds on /api/health", async () => {
    const res = await request(createApp()).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe("cors policy", () => {
  it("never answers a wildcard origin", () => {
    // `cors()` with no arguments sends `Access-Control-Allow-Origin: *`, which
    // lets a page on any domain call /api/ai/keys with a stolen token.
    for (const env of [
      {},
      { NODE_ENV: "production" },
      { NODE_ENV: "production", NOMAD_WEB_ORIGIN: "https://nomad.example" },
    ]) {
      expect(corsOptions(env).origin).not.toBe("*");
    }
  });

  it("allows no cross-origin caller in production by default", () => {
    // Deployed, this process serves web/dist itself: same-origin, no CORS.
    expect(corsOptions({ NODE_ENV: "production" }).origin).toBe(false);
  });

  it("pins production to the configured web origins", () => {
    expect(
      corsOptions({
        NODE_ENV: "production",
        NOMAD_WEB_ORIGIN: "https://nomad.example, https://www.nomad.example",
      }).origin,
    ).toEqual(["https://nomad.example", "https://www.nomad.example"]);
  });

  it("stays permissive in development so Vite on :5173 can call :4000", () => {
    expect(corsOptions({}).origin).toBe(true);
    expect(corsOptions({ NODE_ENV: "development" }).origin).toBe(true);
  });
});
