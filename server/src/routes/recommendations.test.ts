import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";

describe("GET /api/recommendations", () => {
  const app = createApp();

  it("returns mode-grouped picks for a weekend", async () => {
    const res = await request(app).get(
      "/api/recommendations?start=2026-11-07&end=2026-11-09",
    );
    expect(res.status).toBe(200);
    expect(res.body.homeBase).toBe("Delhi-NCR");
    expect(res.body.india.flight.length).toBeGreaterThan(0);
    expect(res.body.india.bike.length).toBeGreaterThan(0);
    expect(res.body.india.bus.length).toBeGreaterThan(0);
    expect(res.body.international.length).toBeGreaterThan(0);
  });

  it("rotates with seed", async () => {
    const q = "start=2026-11-07&end=2026-11-09";
    const s0 = await request(app).get(`/api/recommendations?${q}&seed=0`);
    const s1 = await request(app).get(`/api/recommendations?${q}&seed=1`);
    expect(s1.body.india.bike[0].destination.id).toBe(
      s0.body.india.bike[1].destination.id,
    );
  });

  it("rejects bad input", async () => {
    expect(
      (await request(app).get("/api/recommendations?start=nope&end=2026-11-09"))
        .status,
    ).toBe(400);
    expect(
      (
        await request(app).get(
          "/api/recommendations?start=2026-11-10&end=2026-11-09",
        )
      ).status,
    ).toBe(400);
  });
});

describe("GET /api/destinations/:id", () => {
  const app = createApp();

  it("returns a full destination", async () => {
    const res = await request(app).get("/api/destinations/goa");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Goa");
    expect(res.body.weather).toHaveLength(12);
  });

  it("404s on unknown id", async () => {
    expect((await request(app).get("/api/destinations/atlantis")).status).toBe(
      404,
    );
  });
});
