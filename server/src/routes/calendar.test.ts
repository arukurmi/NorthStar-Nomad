import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";

describe("GET /api/calendar/:year/:month", () => {
  const app = createApp();

  it("returns days, long weekends, and teasers for Nov 2026", async () => {
    const res = await request(app).get("/api/calendar/2026/11");
    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(30);
    expect(res.body.days[0]).toMatchObject({
      date: "2026-11-01",
      isWeekend: true,
    });
    const diwali = res.body.longWeekends.find(
      (lw: { holidayName?: string }) => lw.holidayName === "Diwali",
    );
    expect(diwali).toBeDefined();
    expect(res.body.teasers[diwali.start]).toBeDefined();
    expect(res.body.teasers[diwali.start].name.length).toBeGreaterThan(0);
  });

  it("marks holidays on days", async () => {
    const res = await request(app).get("/api/calendar/2026/1");
    const republicDay = res.body.days.find(
      (d: { date: string }) => d.date === "2026-01-26",
    );
    expect(republicDay.holiday).toBe("Republic Day");
  });

  it("has a teaser for every plain Saturday", async () => {
    const res = await request(app).get("/api/calendar/2026/7");
    const saturdays = res.body.days.filter(
      (d: { date: string }) =>
        new Date(`${d.date}T00:00:00Z`).getUTCDay() === 6,
    );
    for (const sat of saturdays) {
      expect(res.body.teasers[sat.date]).toBeDefined();
    }
  });

  it("rejects bad params", async () => {
    expect((await request(app).get("/api/calendar/2026/13")).status).toBe(400);
    expect((await request(app).get("/api/calendar/banana/2")).status).toBe(400);
  });
});
