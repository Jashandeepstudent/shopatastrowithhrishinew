import { beforeEach, describe, expect, it } from "vitest";

/*
 * Firestore security rules, checked against the running emulators (npm run emulators).
 * Requests use real Auth-emulator ID tokens, so the rules are evaluated exactly as in production.
 * "Bearer owner" is the emulator's rules-bypass, used here only to seed data.
 */

const PROJECT = "demo-astro-hrishi";
const FS = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`;
const AUTH = "http://127.0.0.1:9099";
const KEY = "fake-api-key";

const clearAll = async () => {
  await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
};

type Person = { uid: string; token: string };

const person = async (email: string, claims?: Record<string, unknown>): Promise<Person> => {
  const up = await (await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Passw0rd!123", returnSecureToken: true }),
  })).json();
  if (claims) {
    await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer owner" },
      body: JSON.stringify({ localId: up.localId, customAttributes: JSON.stringify(claims) }),
    });
    const again = await (await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "Passw0rd!123", returnSecureToken: true }),
    })).json();
    return { uid: up.localId, token: again.idToken };
  }
  return { uid: up.localId, token: up.idToken };
};

const toFields = (obj: Record<string, string | number | boolean>) =>
  Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, typeof v === "number" ? { integerValue: String(v) } : typeof v === "boolean" ? { booleanValue: v } : { stringValue: v }])
  );

const send = (token: string | null, method: string, path: string, body?: Record<string, string | number | boolean>, mask?: string[]) => {
  const q = mask ? "?" + mask.map((m) => `updateMask.fieldPaths=${m}`).join("&") : "";
  return fetch(`${FS}/${path}${q}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify({ fields: toFields(body) }) : undefined,
  });
};
const seed = (path: string, body: Record<string, string | number | boolean>) => send("owner", "PATCH", path, body);

let alice: Person, bob: Person, admin: Person, lookalike: Person;

beforeEach(async () => {
  await clearAll();
  alice = await person("alice@example.com");
  bob = await person("bob@example.com");
  admin = await person("admin@example.com", { admin: true });
  // Used to be an admin by email in the old rules; must now be an ordinary account.
  lookalike = await person("former.admin.email@example.com");
  await seed("orders/ord_a", { user_id: alice.uid, payment_status: "created", status: "placed", total: 999 });
  await seed("settings/payment_gateway", { razorpay_key_id: "rzp_test_x" });
  await seed("coupons/WELCOME10", { code: "WELCOME10", active: true });
  await seed("products/p1", { name: "Bracelet", price: 999, active: true });
  await seed("payment_events/e1", { event_type: "payment.captured" });
});

describe("orders and payments cannot be forged from a browser", () => {
  it("a signed-in customer cannot create an order, paid or otherwise", async () => {
    const res = await send(alice.token, "PATCH", "orders/ord_fake", { user_id: alice.uid, payment_status: "paid", status: "payment_confirmed", total: 1 });
    expect(res.status).toBe(403);
    expect((await send("owner", "GET", "orders/ord_fake")).status).toBe(404);
  });

  it("an anonymous visitor cannot create an order", async () => {
    const res = await send(null, "PATCH", "orders/ord_fake2", { payment_status: "paid" });
    expect(res.status).toBe(403);
  });

  it("an owner cannot change their own order's payment or status", async () => {
    const res = await send(alice.token, "PATCH", "orders/ord_a", { payment_status: "paid" }, ["payment_status"]);
    expect(res.status).toBe(403);
    const res2 = await send(alice.token, "PATCH", "orders/ord_a", { status: "delivered" }, ["status"]);
    expect(res2.status).toBe(403);
    const stored = await (await send("owner", "GET", "orders/ord_a")).json();
    expect(stored.fields.payment_status.stringValue).toBe("created");
  });

  it("not even an admin can write orders directly (only the server API can)", async () => {
    const res = await send(admin.token, "PATCH", "orders/ord_a", { payment_status: "paid" }, ["payment_status"]);
    expect(res.status).toBe(403);
    expect((await send(admin.token, "DELETE", "orders/ord_a")).status).toBe(403);
  });

  it("customers cannot write the payment event log", async () => {
    expect((await send(alice.token, "PATCH", "payment_events/e2", { event_type: "payment.captured" })).status).toBe(403);
    expect((await send(alice.token, "GET", "payment_events/e1")).status).toBe(403);
  });
});

describe("order data is private", () => {
  it("the owner and an admin can read an order; other customers and visitors cannot", async () => {
    expect((await send(alice.token, "GET", "orders/ord_a")).status).toBe(200);
    expect((await send(admin.token, "GET", "orders/ord_a")).status).toBe(200);
    expect((await send(bob.token, "GET", "orders/ord_a")).status).toBe(403);
    expect((await send(null, "GET", "orders/ord_a")).status).toBe(403);
  });
});

describe("settings and coupons are not public", () => {
  it("settings (including payment_gateway) are unreadable to visitors and customers", async () => {
    expect((await send(null, "GET", "settings/payment_gateway")).status).toBe(403);
    expect((await send(alice.token, "GET", "settings/payment_gateway")).status).toBe(403);
    expect((await send(admin.token, "GET", "settings/payment_gateway")).status).toBe(200);
  });

  it("settings cannot be written from a browser, even by an admin", async () => {
    expect((await send(admin.token, "PATCH", "settings/payment_gateway", { razorpay_key_secret: "x" })).status).toBe(403);
  });

  it("coupon codes cannot be listed by visitors or customers", async () => {
    expect((await send(null, "GET", "coupons/WELCOME10")).status).toBe(403);
    expect((await send(alice.token, "GET", "coupons/WELCOME10")).status).toBe(403);
    expect((await send(admin.token, "GET", "coupons/WELCOME10")).status).toBe(200);
  });
});

describe("admin rights come from the verified claim only", () => {
  it("an account that merely uses a former admin email is not an admin", async () => {
    expect((await send(lookalike.token, "GET", "coupons/WELCOME10")).status).toBe(403);
    expect((await send(lookalike.token, "PATCH", "products/p1", { price: 1 }, ["price"])).status).toBe(403);
    expect((await send(lookalike.token, "GET", "orders/ord_a")).status).toBe(403);
  });

  it("customers cannot edit the catalogue, admins can, and everyone can read it", async () => {
    expect((await send(null, "GET", "products/p1")).status).toBe(200);
    expect((await send(alice.token, "PATCH", "products/p1", { price: 1 }, ["price"])).status).toBe(403);
    expect((await send(admin.token, "PATCH", "products/p1", { price: 1099 }, ["price"])).status).toBe(200);
  });

  it("customers cannot grant themselves a role", async () => {
    expect((await send(alice.token, "PATCH", `user_roles/${alice.uid}`, { role: "admin" })).status).toBe(403);
  });
});
