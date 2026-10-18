import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* ─── Fake Razorpay SDK (no test keys locally; signatures and Firestore are real) ─── */
const rzp = vi.hoisted(() => {
  const rand = (n: number) => Array.from({ length: n }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 62)]).join("");
  const state = {
    orders: new Map<string, any>(),
    payments: new Map<string, any>(),
    failCreate: false,
    hangCreate: false,
    captureCalls: 0,
    rand,
  };
  class FakeRazorpay {
    orders = {
      create: async (o: any) => {
        if (state.hangCreate) return new Promise(() => {});
        if (state.failCreate) throw { statusCode: 500, error: { description: "gateway down" } };
        const id = `order_${rand(14)}`;
        state.orders.set(id, { ...o, id });
        return { ...o, id };
      },
      fetchPayments: async (orderId: string) => ({
        items: [...state.payments.values()].filter((p) => p.order_id === orderId),
      }),
      all: async () => ({ items: [] }),
    };
    payments = {
      fetch: async (id: string) => {
        const p = state.payments.get(id);
        if (!p) throw { statusCode: 400, error: { description: "The id provided does not exist" } };
        return { ...p };
      },
      capture: async (id: string) => {
        state.captureCalls++;
        const p = state.payments.get(id);
        p.status = "captured";
        return { ...p };
      },
    };
  }
  return { state, FakeRazorpay };
});
vi.mock("razorpay", () => ({ default: rzp.FakeRazorpay }));

import handler from "../functions/api.mts";
import { getDb } from "../lib/firebaseAdmin";

const PROJECT = "demo-astro-hrishi";
const KEY_SECRET = "unit_test_key_secret";
const WEBHOOK_SECRET = "unit_test_webhook_secret";

/* ─── Helpers ─── */

const clearEmulators = async () => {
  await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
};

const signUp = async (email: string) => {
  const res = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "secret123", returnSecureToken: true }),
  });
  const data = await res.json();
  return { uid: data.localId as string, token: data.idToken as string };
};

const call = async (
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; headers?: Record<string, string>; raw?: string } = {}
) => {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers ?? {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await handler(
    new Request(`http://localhost:8888${path}`, {
      method,
      headers,
      body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    })
  );
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null, text };
};

const CUSTOMER = { name: "Test Devotee", phone: "+91 98765 43210", email: "devotee@example.com" };
const ADDRESS = { address: "12 Temple Road", city: "Ahmedabad", state: "Gujarat", pincode: "380001" };

const placeOrder = async (extra: Record<string, unknown> = {}, token?: string) =>
  call("POST", "/api/payments/create-order", {
    token,
    body: { items: [{ id: "trishield-bracelet", quantity: 1 }], customer: CUSTOMER, address: ADDRESS, ...extra },
  });

const sign = (orderId: string, paymentId: string) =>
  crypto.createHmac("sha256", KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");

const addPayment = (orderId: string, overrides: Record<string, unknown> = {}) => {
  const order = rzp.state.orders.get(orderId);
  const payment = {
    id: `pay_${rzp.state.rand(14)}`,
    order_id: orderId,
    amount: order.amount,
    currency: "INR",
    status: "captured",
    method: "card",
    ...overrides,
  };
  rzp.state.payments.set(payment.id, payment);
  return payment;
};

const orderDoc = async (id: string) => (await getDb().collection("orders").doc(id).get()).data()!;

const sendWebhook = (event: unknown, opts: { eventId?: string; secret?: string } = {}) => {
  const raw = JSON.stringify(event);
  const signature = crypto.createHmac("sha256", opts.secret ?? WEBHOOK_SECRET).update(raw).digest("hex");
  return call("POST", "/api/payments/webhook", {
    raw,
    headers: { "x-razorpay-signature": signature, "x-razorpay-event-id": opts.eventId ?? `evt_${rzp.state.rand(14)}` },
  });
};

const paymentEvent = (event: string, payment: any) => ({ event, payload: { payment: { entity: payment } } });

beforeEach(async () => {
  await clearEmulators();
  rzp.state.orders.clear();
  rzp.state.payments.clear();
  rzp.state.failCreate = false;
  rzp.state.hangCreate = false;
  rzp.state.captureCalls = 0;
  process.env.ADMIN_UIDS = "";
});

/* ─── Router ─── */

describe("router", () => {
  it("returns JSON 404 for unknown and unported routes", async () => {
    for (const path of ["/api/nope", "/api/customer/reset-password", "/api/customer/forgot-password", "/api/admin/login", "/api/admin/forgot-password"]) {
      const res = await call("POST", path, { body: {} });
      expect(res.status, path).toBe(404);
    }
  });

  it("returns 405 for a wrong method", async () => {
    expect((await call("GET", "/api/payments/create-order")).status).toBe(405);
  });

  it("serves the same routes under /.netlify/functions/api", async () => {
    expect((await call("GET", "/.netlify/functions/api/health")).data).toEqual({ ok: true });
  });
});

/* ─── Payments ─── */

describe("payments/config", () => {
  it("returns only the public key id", async () => {
    const res = await call("GET", "/api/payments/config");
    expect(res.status).toBe(200);
    expect(res.data.razorpay_key_id).toBe("rzp_test_UnitTestKey01");
    expect(res.text).not.toContain(KEY_SECRET);
    expect(res.data.test_mode).toBe(false);
  });
});

describe("payments/create-order", () => {
  it("prices from the catalog and ignores browser price, test_mode and is_test", async () => {
    const res = await call("POST", "/api/payments/create-order", {
      body: {
        items: [{ id: "trishield-bracelet", quantity: 1, price: 1, name: "Live Payment Test ₹10" }],
        customer: CUSTOMER,
        address: ADDRESS,
        test_mode: true,
        is_test: true,
        force_live_value: false,
      },
    });
    expect(res.status).toBe(200);
    expect(res.data.total).toBe(829); // 750 + 79 shipping
    expect(res.data.amount).toBe(82900);
    expect(res.data.key_id).toBe("rzp_test_UnitTestKey01");
    expect(rzp.state.orders.get(res.data.razorpay_order_id).amount).toBe(82900);

    const doc = await orderDoc(res.data.order_id);
    expect(doc).toMatchObject({ payment_status: "created", status: "placed", total: 829, customer_phone: "9876543210", user_id: null });
    expect(doc.items[0]).toMatchObject({ id: "trishield-bracelet", price: 750, quantity: 1 });
  });

  it("gives free shipping from Rs 999 and uses admin price edits from Firestore", async () => {
    await getDb().collection("products").doc("rose-quartz-bracelet").set({ price: 650 });
    const res = await placeOrder({ items: [{ id: "rose-quartz-bracelet", quantity: 2 }] });
    expect(res.data.total).toBe(1300);
    expect(res.data.shipping).toBe(0);
  });

  it("rejects unknown, inactive and test products and bad quantities", async () => {
    await getDb().collection("products").doc("chakra-tree").set({ active: false });
    const cases = [
      [{ id: "does-not-exist", quantity: 1 }],
      [{ id: "chakra-tree", quantity: 1 }],
      [{ id: "live-payment-test-10inr", quantity: 1 }],
      [{ id: "live-payment-test-1inr", quantity: 1 }],
      [{ id: "trishield-bracelet", quantity: 0 }],
      [{ id: "trishield-bracelet", quantity: 11 }],
      [{ id: "trishield-bracelet", quantity: 1.5 }],
      [],
    ];
    for (const items of cases) {
      const res = await placeOrder({ items });
      expect(res.status, JSON.stringify(items)).toBe(400);
    }
    expect((await getDb().collection("orders").get()).size).toBe(0);
  });

  it("rejects FIRST3FREE and unknown coupons, applies Firestore coupons", async () => {
    // Even if the client database still has a FIRST3FREE document, it must never apply.
    await getDb().collection("coupons").add({ code: "FIRST3FREE", discount_type: "percent", discount_value: 100, min_order: 0, active: true });
    expect((await placeOrder({ couponCode: "FIRST3FREE" })).status).toBe(400);
    expect((await placeOrder({ couponCode: "DIVINE10" })).status).toBe(400);
    await getDb().collection("coupons").add({ code: "SAVE10", discount_type: "percent", discount_value: 10, min_order: 500, active: true });
    const res = await placeOrder({ couponCode: "save10" });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ subtotal: 750, discount: 75, shipping: 79, total: 754 });
  });

  it("validates customer details", async () => {
    expect((await placeOrder({ customer: { ...CUSTOMER, phone: "12345" } })).status).toBe(400);
    expect((await placeOrder({ address: { ...ADDRESS, pincode: "38" } })).status).toBe(400);
    expect((await placeOrder({ customer: { ...CUSTOMER, email: "not-an-email" } })).status).toBe(400);
  });

  it("links the order to a verified Firebase user and rejects invalid tokens", async () => {
    const { uid, token } = await signUp("buyer@example.com");
    const res = await placeOrder({}, token);
    expect((await orderDoc(res.data.order_id)).user_id).toBe(uid);
    expect((await placeOrder({}, "garbage-token")).status).toBe(401);
  });

  it("fails cleanly within Netlify's time limit when Razorpay hangs", async () => {
    rzp.state.hangCreate = true;
    const started = Date.now();
    const res = await placeOrder();
    expect(res.status).toBe(502);
    expect(Date.now() - started).toBeLessThan(9500);
    expect((await getDb().collection("orders").get()).size).toBe(0);
  });

  it("never creates an order when Razorpay fails", async () => {
    rzp.state.failCreate = true;
    const res = await placeOrder();
    expect(res.status).toBe(502);
    expect((await getDb().collection("orders").get()).size).toBe(0);
  });
});

describe("payments/verify-payment", () => {
  it("marks paid only after signature and gateway checks, and is idempotent", async () => {
    const order = (await placeOrder()).data;
    const payment = addPayment(order.razorpay_order_id);
    const body = {
      order_id: order.order_id,
      razorpay_order_id: order.razorpay_order_id,
      razorpay_payment_id: payment.id,
      razorpay_signature: sign(order.razorpay_order_id, payment.id),
    };

    const res = await call("POST", "/api/payments/verify-payment", { body });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ success: true, payment_status: "paid", status: "payment_confirmed", payment_id: payment.id, total: 829 });

    const again = await call("POST", "/api/payments/verify-payment", { body });
    expect(again.status).toBe(200);
    const doc = await orderDoc(order.order_id);
    expect(doc.history.filter((h: any) => h.status === "payment_confirmed")).toHaveLength(1);
    expect(doc.inventory_deducted).toBe(true);
  });

  it("keeps the payment method Razorpay reports (card stays card, upi stays upi)", async () => {
    for (const method of ["card", "upi"]) {
      const order = (await placeOrder()).data;
      const payment = addPayment(order.razorpay_order_id, { method });
      const body = { razorpay_order_id: order.razorpay_order_id, razorpay_payment_id: payment.id, razorpay_signature: sign(order.razorpay_order_id, payment.id) };
      const res = await call("POST", "/api/payments/verify-payment", { body });
      expect(res.data.payment_method, method).toBe(method);
      const status = await call("GET", `/api/payments/order-status?order_id=${order.order_id}`);
      expect(status.data.payment_method, method).toBe(method);
    }
  });

  it("deducts tracked stock once", async () => {
    await getDb().collection("products").doc("trishield-bracelet").set({ stock: 5 });
    const order = (await placeOrder({ items: [{ id: "trishield-bracelet", quantity: 2 }] })).data;
    const payment = addPayment(order.razorpay_order_id);
    const body = { razorpay_order_id: order.razorpay_order_id, razorpay_payment_id: payment.id, razorpay_signature: sign(order.razorpay_order_id, payment.id) };
    await call("POST", "/api/payments/verify-payment", { body });
    await call("POST", "/api/payments/verify-payment", { body });
    expect((await getDb().collection("products").doc("trishield-bracelet").get()).data()!.stock).toBe(3);
  });

  it("rejects a tampered signature", async () => {
    const order = (await placeOrder()).data;
    const payment = addPayment(order.razorpay_order_id);
    const res = await call("POST", "/api/payments/verify-payment", {
      body: { razorpay_order_id: order.razorpay_order_id, razorpay_payment_id: payment.id, razorpay_signature: "0".repeat(64) },
    });
    expect(res.status).toBe(400);
    expect((await orderDoc(order.order_id)).payment_status).toBe("created");
  });

  it("rejects a fake pay_<timestamp> id even with a valid signature", async () => {
    const order = (await placeOrder()).data;
    const fake = `pay_${Date.now()}`;
    const res = await call("POST", "/api/payments/verify-payment", {
      body: { razorpay_order_id: order.razorpay_order_id, razorpay_payment_id: fake, razorpay_signature: sign(order.razorpay_order_id, fake) },
    });
    expect(res.status).toBe(400);
    expect((await orderDoc(order.order_id)).payment_status).toBe("created");
  });

  it("rejects a payment with the wrong amount or for another order", async () => {
    const order = (await placeOrder()).data;
    const other = (await placeOrder()).data;
    const cheap = addPayment(order.razorpay_order_id, { amount: 1000 });
    const foreign = addPayment(other.razorpay_order_id);
    for (const p of [cheap, foreign]) {
      const res = await call("POST", "/api/payments/verify-payment", {
        body: { razorpay_order_id: order.razorpay_order_id, razorpay_payment_id: p.id, razorpay_signature: sign(order.razorpay_order_id, p.id) },
      });
      expect(res.status).toBe(400);
    }
    expect((await orderDoc(order.order_id)).payment_status).toBe("created");
  });

  it("captures an authorized payment, and records a failed one as failed", async () => {
    const order = (await placeOrder()).data;
    const authorized = addPayment(order.razorpay_order_id, { status: "authorized" });
    const ok = await call("POST", "/api/payments/verify-payment", {
      body: { razorpay_order_id: order.razorpay_order_id, razorpay_payment_id: authorized.id, razorpay_signature: sign(order.razorpay_order_id, authorized.id) },
    });
    expect(ok.data.payment_status).toBe("paid");
    expect(rzp.state.captureCalls).toBe(1);

    const order2 = (await placeOrder()).data;
    const failed = addPayment(order2.razorpay_order_id, { status: "failed", error_description: "Card declined" });
    const res = await call("POST", "/api/payments/verify-payment", {
      body: { razorpay_order_id: order2.razorpay_order_id, razorpay_payment_id: failed.id, razorpay_signature: sign(order2.razorpay_order_id, failed.id) },
    });
    expect(res.status).toBe(402);
    expect(await orderDoc(order2.order_id)).toMatchObject({ payment_status: "failed", status: "payment_failed", failure_reason: "Card declined" });
  });
});

describe("payments/order-status", () => {
  it("returns the receipt for the order id and status only for the order number", async () => {
    const order = (await placeOrder()).data;
    const full = await call("GET", `/api/payments/order-status?order_id=${order.order_id}`);
    expect(full.data).toMatchObject({ order_number: order.order_number, payment_status: "created", customer_name: "Test Devotee" });

    const limited = await call("GET", `/api/payments/order-status?order_number=${order.order_number}`);
    expect(limited.data).toEqual({ success: true, order_number: order.order_number, status: "placed", payment_status: "created" });
  });

  it("marks paid only when Razorpay shows a captured payment", async () => {
    const order = (await placeOrder()).data;
    addPayment(order.razorpay_order_id, { status: "failed" });
    const notYet = await call("GET", `/api/payments/order-status?order_id=${order.order_id}`);
    expect(notYet.data.payment_status).toBe("created");

    await getDb().collection("orders").doc(order.order_id).update({ last_gateway_check_at: null });
    addPayment(order.razorpay_order_id, { status: "captured" });
    const paid = await call("GET", `/api/payments/order-status?razorpay_order_id=${order.razorpay_order_id}`);
    expect(paid.data.payment_status).toBe("paid");
  });

  it("rejects malformed and unknown ids", async () => {
    expect((await call("GET", "/api/payments/order-status")).status).toBe(400);
    expect((await call("GET", "/api/payments/order-status?order_id=ord_123")).status).toBe(400);
    expect((await call("GET", `/api/payments/order-status?order_id=ord_${"a".repeat(24)}`)).status).toBe(404);
  });
});

/* ─── Webhook ─── */

describe("payments/webhook", () => {
  it("marks paid on a signed payment.captured and ignores duplicates", async () => {
    const order = (await placeOrder()).data;
    const payment = addPayment(order.razorpay_order_id);
    const res = await sendWebhook(paymentEvent("payment.captured", payment), { eventId: "evt_dup_1" });
    expect(res.data.outcome).toBe("marked_paid");
    expect((await orderDoc(order.order_id)).payment_status).toBe("paid");

    const dup = await sendWebhook(paymentEvent("payment.captured", payment), { eventId: "evt_dup_1" });
    expect(dup.data.status).toBe("duplicate");

    const orderPaid = await sendWebhook(paymentEvent("order.paid", payment));
    expect(orderPaid.data.outcome).toBe("no_change");
  });

  it("rejects a wrong signature", async () => {
    const order = (await placeOrder()).data;
    const payment = addPayment(order.razorpay_order_id);
    const res = await sendWebhook(paymentEvent("payment.captured", payment), { secret: "wrong" });
    expect(res.status).toBe(400);
    expect((await orderDoc(order.order_id)).payment_status).toBe("created");
  });

  it("never moves a paid order back to failed", async () => {
    const order = (await placeOrder()).data;
    const good = addPayment(order.razorpay_order_id);
    await sendWebhook(paymentEvent("payment.captured", good));
    const late = await sendWebhook(paymentEvent("payment.failed", { ...good, id: `pay_${rzp.state.rand(14)}`, status: "failed" }));
    expect(late.data.outcome).toBe("no_change");
    expect((await orderDoc(order.order_id)).payment_status).toBe("paid");
  });

  it("marks failed, then paid on a successful retry", async () => {
    const order = (await placeOrder()).data;
    const failed = addPayment(order.razorpay_order_id, { status: "failed", error_description: "Bank declined" });
    await sendWebhook(paymentEvent("payment.failed", failed));
    expect((await orderDoc(order.order_id)).payment_status).toBe("failed");
    await sendWebhook(paymentEvent("payment.captured", addPayment(order.razorpay_order_id)));
    expect((await orderDoc(order.order_id)).payment_status).toBe("paid");
  });

  it("rejects an amount mismatch and records refunds", async () => {
    const order = (await placeOrder()).data;
    const wrong = await sendWebhook(paymentEvent("payment.captured", addPayment(order.razorpay_order_id, { amount: 100 })));
    expect(wrong.data.outcome).toBe("rejected_mismatch");
    expect((await orderDoc(order.order_id)).payment_status).toBe("created");

    const good = addPayment(order.razorpay_order_id);
    await sendWebhook(paymentEvent("payment.captured", good));
    await sendWebhook({ event: "refund.processed", payload: { payment: { entity: { ...good, amount_refunded: good.amount } } } });
    expect(await orderDoc(order.order_id)).toMatchObject({ payment_status: "refunded", status: "refunded" });
  });

  it("acknowledges events for unknown orders and does not store the payload", async () => {
    const res = await sendWebhook(paymentEvent("payment.captured", { id: "pay_ABCDEFGHIJKLMN", order_id: "order_UNKNOWN0000001", amount: 100, currency: "INR", status: "captured", email: "x@y.z" }), { eventId: "evt_unknown" });
    expect(res.data.outcome).toBe("order_not_found");
    const stored = (await getDb().collection("payment_events").doc("evt_unknown").get()).data()!;
    expect(stored.payload).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain("x@y.z");
  });
});

/* ─── Tracking ─── */

describe("tracking/lookup", () => {
  it("needs the order number plus a matching phone or email", async () => {
    const order = (await placeOrder()).data;
    expect((await call("GET", `/api/tracking/lookup?q=${order.order_number}`)).status).toBe(400);
    expect((await call("GET", `/api/tracking/lookup?q=${order.order_number}&phone=9999999999`)).status).toBe(404);
    expect((await call("GET", `/api/tracking/lookup?q=${order.order_number}&phone=43210`)).status).toBe(404);

    const byPhone = await call("GET", `/api/tracking/lookup?q=${order.order_number.toLowerCase()}&phone=09876543210`);
    expect(byPhone.status).toBe(200);
    expect(byPhone.data.order.customer_phone).toBe("98******10");
    expect(byPhone.text).not.toContain("devotee@example.com");
    expect(byPhone.text).not.toContain("12 Temple Road");

    const byEmail = await call("GET", `/api/tracking/lookup?q=${order.order_number}&phone=DEVOTEE@example.com`);
    expect(byEmail.status).toBe(200);
  });
});

/* ─── Admin ─── */

describe("admin", () => {
  const makeAdmin = async () => {
    const admin = await signUp("owner@example.com");
    process.env.ADMIN_UIDS = `someone-else,${admin.uid}`;
    return admin.token;
  };

  it("requires a verified admin token", async () => {
    const customer = await signUp("customer@example.com");
    expect((await call("GET", "/api/admin/stats")).status).toBe(401);
    expect((await call("GET", "/api/admin/stats", { token: "not-a-jwt" })).status).toBe(401);
    expect((await call("GET", "/api/admin/stats", { token: customer.token })).status).toBe(403);
    expect((await call("POST", "/api/admin/verify-admin", { token: customer.token })).data.authorized).toBe(false);

    const token = await makeAdmin();
    expect((await call("POST", "/api/admin/verify-token", { token })).data.authorized).toBe(true);
  });

  it("counts only paid orders as revenue", async () => {
    const token = await makeAdmin();
    const paid = (await placeOrder()).data;
    await placeOrder();
    await sendWebhook(paymentEvent("payment.captured", addPayment(paid.razorpay_order_id)));
    const stats = await call("GET", "/api/admin/stats", { token });
    expect(stats.data).toMatchObject({ orders: 2, revenue: 829 });
  });

  it("lists allowlisted collections and hides password fields", async () => {
    const token = await makeAdmin();
    await getDb().collection("profiles").doc("p1").set({ email: "a@b.c", password_hash: "x", salt: "y" });
    const profiles = await call("GET", "/api/admin/collection/profiles", { token });
    expect(profiles.data.data[0]).toEqual({ id: "p1", email: "a@b.c" });
    expect((await call("GET", "/api/admin/collection/user_roles", { token })).status).toBe(404);
    expect((await call("GET", "/api/admin/collection/payment_events", { token })).status).toBe(404);

    const products = await call("GET", "/api/admin/collection/products", { token });
    expect(products.data.data.length).toBeGreaterThanOrEqual(11);
  });

  it("can update fulfilment but never payment fields, and cannot ship unpaid orders", async () => {
    const token = await makeAdmin();
    const unpaid = (await placeOrder()).data;
    const put = (id: string, body: unknown) => call("PUT", `/api/admin/collection/orders/${id}`, { token, body });

    expect((await put(unpaid.order_id, { payment_status: "paid" })).status).toBe(400);
    expect((await put(unpaid.order_id, { status: "shipped" })).status).toBe(409);
    expect((await put(unpaid.order_id, { status: "payment_confirmed" })).status).toBe(409);
    expect((await orderDoc(unpaid.order_id)).payment_status).toBe("created");
    expect((await put(unpaid.order_id, { status: "cancelled", cancellation_reason: "Customer asked" })).status).toBe(200);

    const paid = (await placeOrder()).data;
    await sendWebhook(paymentEvent("payment.captured", addPayment(paid.razorpay_order_id)));
    const res = await put(paid.order_id, { status: "shipped", courier_name: "Delhivery", tracking_number: "DL123", note: "Dispatched" });
    expect(res.status).toBe(200);
    const doc = await orderDoc(paid.order_id);
    expect(doc).toMatchObject({ status: "shipped", courier_name: "Delhivery", payment_status: "paid" });
    expect(doc.history.at(-1)).toMatchObject({ old_status: "payment_confirmed", new_status: "shipped", note: "Dispatched" });
    expect((await put(paid.order_id, { status: "placed" })).status).toBe(409);
  });

  it("cannot delete orders; can manage content collections", async () => {
    const token = await makeAdmin();
    const order = (await placeOrder()).data;
    expect((await call("DELETE", `/api/admin/collection/orders/${order.order_id}`, { token })).status).toBe(404);
    const created = await call("POST", "/api/admin/collection/coupons", { token, body: { code: "festive5", discount_type: "percent", discount_value: 5 } });
    expect(created.data.data.code).toBe("FESTIVE5");
    expect((await call("DELETE", `/api/admin/collection/coupons/${created.data.id}`, { token })).status).toBe(200);
    expect((await call("POST", "/api/admin/collection/products", { token, body: { name: "X", price: -5 } })).status).toBe(400);
  });

  it("never exposes or stores Razorpay secrets via payment settings", async () => {
    const token = await makeAdmin();
    const res = await call("GET", "/api/admin/payment-settings", { token });
    expect(res.data.settings).toMatchObject({ has_key_secret: true, has_webhook_secret: true, razorpay_key_id: "rzp_test_UnitTestKey01" });
    expect(res.text).not.toContain(KEY_SECRET);
    expect(res.text).not.toContain(WEBHOOK_SECRET);
    expect((await call("POST", "/api/admin/payment-settings", { token, body: { razorpay_key_secret: "x" } })).status).toBe(400);
    expect((await getDb().collection("settings").doc("payment_gateway").get()).exists).toBe(false);
  });
});

describe("admin media upload and custom-claim admins", () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const upload = (token: string | undefined, over: Record<string, unknown>) =>
    call("POST", "/api/admin/upload-media", {
      token,
      body: { data: `data:image/png;base64,${PNG.toString("base64")}`, filename: "photo.png", contentType: "image/png", ...over },
    });

  const adminByClaim = async () => {
    const user = await signUp("claim-admin@example.com");
    await fetch(`http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer owner" },
      body: JSON.stringify({ localId: user.uid, customAttributes: JSON.stringify({ admin: true }) }),
    });
    const again = await (await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "claim-admin@example.com", password: "secret123", returnSecureToken: true }),
    })).json();
    return again.idToken as string;
  };

  it("an account with the admin claim is accepted, without being in ADMIN_UIDS", async () => {
    process.env.ADMIN_UIDS = "";
    const token = await adminByClaim();
    expect((await call("POST", "/api/admin/verify-admin", { token })).data.authorized).toBe(true);
  });

  it("upload requires an admin", async () => {
    const customer = await signUp("shopper@example.com");
    expect((await upload(undefined, {})).status).toBe(401);
    expect((await upload(customer.token, {})).status).toBe(403);
  });

  it("rejects html, svg, scripts and non-image files before storing anything", async () => {
    process.env.ADMIN_UIDS = "";
    const token = await adminByClaim();
    const html = Buffer.from("<html><script>alert(1)</script></html>").toString("base64");
    const svg = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>").toString("base64");

    const cases: Record<string, unknown>[] = [
      { data: html, filename: "page.html", contentType: "text/html" },
      { data: svg, filename: "logo.svg", contentType: "image/svg+xml" },
      { data: html, filename: "page.png", contentType: "image/png" }, // html renamed to .png
      { data: html, filename: "page.html", contentType: "image/png" },
      { filename: "photo.exe", contentType: "image/png" }, // png bytes, wrong extension
      { filename: "photo.png", contentType: "text/html" }, // png bytes, wrong declared type
      { data: "not base64 !!!" },
      { data: "" },
    ];
    for (const c of cases) {
      const res = await upload(token, c);
      expect(res.status, JSON.stringify(c).slice(0, 80)).toBe(400);
    }
  });

  it("rejects images over 4 MB", async () => {
    process.env.ADMIN_UIDS = "";
    const token = await adminByClaim();
    const big = Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]);
    const res = await upload(token, { data: big.toString("base64") });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/4 MB/);
  });

  it("media URLs only serve keys this API created (no path tricks)", async () => {
    expect((await call("GET", "/api/media/..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
    expect((await call("GET", "/api/media/evil.html")).status).toBe(404);
    expect((await call("GET", "/api/media/media-1-aaaaaaaaaaaa.png")).status).toBeGreaterThanOrEqual(404);
  });
});

describe("payments/check-attempt (failed attempts and captured payments found by the server)", () => {
  const BLOCKED = "Payment blocked as website does not match registered website(s)";
  const check = (orderId: string, body: Record<string, unknown> = {}) =>
    call("POST", "/api/payments/check-attempt", { body: { order_id: orderId, ...body } });
  const failedAttempt = (rzpOrderId: string, extra: Record<string, unknown> = {}) =>
    addPayment(rzpOrderId, { status: "failed", method: "upi", error_code: "BAD_REQUEST_ERROR", error_description: BLOCKED, error_reason: "payment_risk_check_failed", ...extra });

  it("stores Razorpay's reason and the attempt count for failed attempts, and never marks paid", async () => {
    const o = (await placeOrder()).data;
    failedAttempt(o.razorpay_order_id, { created_at: 100 });
    failedAttempt(o.razorpay_order_id, { created_at: 200 });
    const res = await check(o.order_id);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ payment_status: "failed", failure_reason: BLOCKED, payment_attempts: 2 });
    const stored = (await getDb().collection("orders").doc(o.order_id).get()).data()!;
    expect(stored).toMatchObject({ payment_status: "failed", status: "payment_failed", payment_id: null, payment_attempts: 2 });
    expect(stored.last_failed_payment_id).toMatch(/^pay_/);
  });

  it("is idempotent: asking again changes nothing and adds no history", async () => {
    const o = (await placeOrder()).data;
    failedAttempt(o.razorpay_order_id);
    await check(o.order_id);
    const ref = getDb().collection("orders").doc(o.order_id);
    const before = (await ref.get()).data()!;
    await ref.update({ last_attempt_check_at: new Date(Date.now() - 60_000).toISOString() }); // past the short pause
    await check(o.order_id);
    const after = (await ref.get()).data()!;
    expect(after.history.length).toBe(before.history.length);
    expect(after.payment_attempts).toBe(1);
  });

  it("a captured payment found by the server makes the order paid (same checks as verify)", async () => {
    const o = (await placeOrder()).data;
    failedAttempt(o.razorpay_order_id);
    const good = addPayment(o.razorpay_order_id, { method: "upi" });
    const res = await check(o.order_id);
    expect(res.data).toMatchObject({ payment_status: "paid", payment_id: good.id });
    expect((await getDb().collection("orders").doc(o.order_id).get()).data()).toMatchObject({ payment_status: "paid", payment_id: good.id });
  });

  it("a captured payment with the wrong amount is refused and the order stays unpaid", async () => {
    const o = (await placeOrder()).data;
    addPayment(o.razorpay_order_id, { amount: 100 });
    const res = await check(o.order_id);
    expect(res.status).toBe(400);
    expect((await getDb().collection("orders").doc(o.order_id).get()).data()!.payment_status).toBe("created");
  });

  it("with no attempts at all, nothing changes", async () => {
    const o = (await placeOrder()).data;
    const res = await check(o.order_id);
    expect(res.status).toBe(200);
    expect(res.data.payment_status).toBe("created");
    expect((await getDb().collection("orders").doc(o.order_id).get()).data()).toMatchObject({ payment_status: "created", status: "placed" });
  });

  it("ignores anything the browser claims, and rejects bad or unknown ids", async () => {
    const o = (await placeOrder()).data;
    const res = await check(o.order_id, { payment_status: "paid", status: "paid", payment_id: "pay_Fake1234567890", razorpay_payment_id: "pay_Fake1234567890" });
    expect(res.data.payment_status).toBe("created");
    expect((await check("not-an-id")).status).toBe(400);
    expect((await check("ord_" + "0".repeat(24))).status).toBe(404);
    expect((await call("POST", "/api/payments/check-attempt", { raw: "{}" })).status).toBe(400);
  });

  it("an already paid order never moves back, even if a failed attempt exists", async () => {
    const o = (await placeOrder()).data;
    const good = addPayment(o.razorpay_order_id);
    await sendWebhook(paymentEvent("payment.captured", good));
    failedAttempt(o.razorpay_order_id);
    const res = await check(o.order_id);
    expect(res.data.payment_status).toBe("paid");
    expect((await getDb().collection("orders").doc(o.order_id).get()).data()!.payment_status).toBe("paid");
  });

  it("a later successful payment still works after a recorded failure", async () => {
    const o = (await placeOrder()).data;
    failedAttempt(o.razorpay_order_id);
    await check(o.order_id);
    expect((await getDb().collection("orders").doc(o.order_id).get()).data()!.payment_status).toBe("failed");
    const good = addPayment(o.razorpay_order_id);
    await getDb().collection("orders").doc(o.order_id).update({ last_attempt_check_at: new Date(Date.now() - 60_000).toISOString() });
    const res = await check(o.order_id);
    expect(res.data).toMatchObject({ payment_status: "paid", payment_id: good.id });
  });

  it("returns 502 and changes nothing when Razorpay cannot be read", async () => {
    const o = (await placeOrder()).data;
    const razorpay = (await import("../lib/razorpay")).getRazorpay();
    const original = razorpay.orders.fetchPayments;
    (razorpay.orders as any).fetchPayments = async () => { throw { statusCode: 500, error: { description: "down" } }; };
    const res = await check(o.order_id);
    (razorpay.orders as any).fetchPayments = original;
    expect(res.status).toBe(502);
    expect((await getDb().collection("orders").doc(o.order_id).get()).data()!.payment_status).toBe("created");
  });
});
