import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { corsOptions, createApp } from "./app.js";

/**
 * A key-shaped canary. The middle slice is what the assertions look for: the
 * prefix is shared by every key of that vendor and proves nothing.
 */
const CANARY = "AIzaSyCANARYd33pSECRETmaterial0123456789";
const CANARY_MIDDLE = CANARY.slice(4, 20);

describe("app", () => {
  it("responds on /api/health", async () => {
    const res = await request(createApp()).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe("malformed request bodies", () => {
  /**
   * Before this handler existed, Express's finalhandler answered these with an
   * HTML page containing `err.stack`. V8's JSON parse errors quote a ~10-
   * character window of the raw body, and POST /api/ai/keys is the one route
   * whose body is a credential — so the window was key material. The parser
   * fails before our code runs, so no AiError guard could have caught it.
   */
  const MALFORMED: Record<string, string> = {
    unquotedValue: `{"apiKey": ${CANARY}}`,
    truncated: `{"provider":"gemini","apiKey":"${CANARY}"`,
    trailingGarbage: `{"provider":"gemini","apiKey":"${CANARY}"}}`,
    bareKey: CANARY,
  };

  for (const [name, body] of Object.entries(MALFORMED)) {
    it(`answers a clean 400 and echoes nothing for a ${name} body`, async () => {
      // The app is put in development mode on purpose: that is the environment
      // in which finalhandler both writes the stack to the response and logs
      // it, so the assertion has something real to prove.
      const app = createApp();
      app.set("env", "development");
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      const stderr = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);

      const res = await request(app)
        .post("/api/ai/keys")
        .set("content-type", "application/json")
        .set("authorization", "Bearer whatever")
        .send(body);
      // finalhandler defers its logging with setImmediate, so give it a turn.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const logged = [...errorLog.mock.calls, ...stderr.mock.calls]
        .flat()
        .map(String)
        .join("\n");
      errorLog.mockRestore();
      stderr.mockRestore();

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: "that request body is not valid JSON",
        code: "bad_request",
      });
      // No echo of the body, no stack, no filesystem paths.
      expect(res.text).not.toContain(CANARY_MIDDLE);
      expect(res.text).not.toContain("AIza");
      expect(res.text).not.toContain("SyntaxError");
      expect(res.text).not.toContain("node_modules");
      // And nothing derived from the body reached stderr either.
      expect(logged).not.toContain(CANARY_MIDDLE);
      expect(logged).not.toContain("AIza");
    });
  }

  it("answers 400 rather than an HTML error page for an oversized body", async () => {
    const res = await request(createApp())
      .post("/api/ai/keys")
      .set("content-type", "application/json")
      .set("authorization", "Bearer whatever")
      .send(`{"apiKey":"${"x".repeat(200_000)}"}`);
    // express.json's default limit is 100kb; whatever the outcome, it is JSON
    // in our own shape and it does not quote the body.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text).not.toContain("SyntaxError");
    expect(res.text).not.toContain("node_modules");
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
