import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";

describe("app", () => {
  it("responds on /api/health", async () => {
    const res = await request(createApp()).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
