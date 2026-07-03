import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";

const app = createApp();

async function register(email: string) {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ name: "Test Nomad", email, password: "wanderlust1" });
  return res;
}

describe("auth", () => {
  it("registers, returns a token, and serves /me", async () => {
    const res = await register("a@nomad.test");
    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    expect(res.body.user).toEqual({
      id: expect.any(Number),
      name: "Test Nomad",
      email: "a@nomad.test",
    });

    const me = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("a@nomad.test");
  });

  it("rejects duplicate emails and weak passwords", async () => {
    await register("dup@nomad.test");
    expect((await register("dup@nomad.test")).status).toBe(409);
    const weak = await request(app)
      .post("/api/auth/register")
      .send({ name: "Weak", email: "weak@nomad.test", password: "short" });
    expect(weak.status).toBe(400);
  });

  it("logs in with correct password only", async () => {
    await register("login@nomad.test");
    const ok = await request(app)
      .post("/api/auth/login")
      .send({ email: "login@nomad.test", password: "wanderlust1" });
    expect(ok.status).toBe(200);
    const bad = await request(app)
      .post("/api/auth/login")
      .send({ email: "login@nomad.test", password: "wrong-pass" });
    expect(bad.status).toBe(401);
  });

  it("never returns password hashes", async () => {
    const res = await register("hash@nomad.test");
    expect(JSON.stringify(res.body)).not.toContain("password");
  });

  it("401s /me without a token", async () => {
    expect((await request(app).get("/api/auth/me")).status).toBe(401);
  });
});

describe("trips authorization", () => {
  it("keeps each user's trips private", async () => {
    const alice = (await register("alice@nomad.test")).body.token;
    const bob = (await register("bob@nomad.test")).body.token;

    const created = await request(app)
      .post("/api/trips")
      .set("Authorization", `Bearer ${alice}`)
      .send({
        destinationId: "goa",
        start: "2026-07-04",
        end: "2026-07-05",
        mode: "flight",
      });
    expect(created.status).toBe(201);
    const tripId = created.body.trip.id;

    // Bob sees an empty list, and cannot touch Alice's trip.
    const bobList = await request(app)
      .get("/api/trips")
      .set("Authorization", `Bearer ${bob}`);
    expect(bobList.body.trips).toHaveLength(0);

    const bobPatch = await request(app)
      .patch(`/api/trips/${tripId}`)
      .set("Authorization", `Bearer ${bob}`)
      .send({ status: "taken" });
    expect(bobPatch.status).toBe(404);

    const bobDelete = await request(app)
      .delete(`/api/trips/${tripId}`)
      .set("Authorization", `Bearer ${bob}`);
    expect(bobDelete.status).toBe(404);

    // Alice can.
    const alicePatch = await request(app)
      .patch(`/api/trips/${tripId}`)
      .set("Authorization", `Bearer ${alice}`)
      .send({ status: "taken" });
    expect(alicePatch.status).toBe(200);
    expect(alicePatch.body.trip.status).toBe("taken");
  });

  it("check-in lists only ended planned trips", async () => {
    const token = (await register("checkin@nomad.test")).body.token;
    await request(app)
      .post("/api/trips")
      .set("Authorization", `Bearer ${token}`)
      .send({ destinationId: "jaipur", start: "2020-01-04", end: "2020-01-05" });
    await request(app)
      .post("/api/trips")
      .set("Authorization", `Bearer ${token}`)
      .send({ destinationId: "goa", start: "2099-01-04", end: "2099-01-05" });

    const res = await request(app)
      .get("/api/trips/check-in")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.trips).toHaveLength(1);
    expect(res.body.trips[0].destination_id).toBe("jaipur");
  });

  it("requires auth for all trip routes", async () => {
    expect((await request(app).get("/api/trips")).status).toBe(401);
    expect((await request(app).post("/api/trips").send({})).status).toBe(401);
  });
});
