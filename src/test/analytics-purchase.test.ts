import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("firebase/firestore", () => ({ addDoc: vi.fn(() => Promise.resolve()), collection: vi.fn() }));
vi.mock("@/lib/firebase", () => ({ db: {}, auth: { currentUser: null } }));

const load = async () => {
  vi.resetModules();
  vi.stubEnv("VITE_GOOGLE_ADS_ID", "123456789");
  vi.stubEnv("VITE_GOOGLE_ADS_CONVERSION_LABEL", "LBL");
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
  (window as any).__AWH_GA_INITIALIZED__ = false;
  (window as any).dataLayer = [];
  delete (window as any).gtag;
  return import("@/lib/analytics");
};

const order = { orderId: "ord_1", orderNumber: "AWH-2026-ABC234", total: 829, shipping: 79, items: [{ id: "p1", name: "Bracelet", price: 750, quantity: 1 }] };
const events = (name: string) => ((window as any).dataLayer as any[]).filter((e) => e[0] === "event" && e[1] === name);

beforeEach(() => localStorage.clear());

describe("analytics purchase", () => {
  it("waits for the tags, then fires purchase and the Ads conversion once", async () => {
    const a = await load();
    const fbq = vi.fn();
    (window as any).fbq = fbq;
    expect(a.trackPurchase(order)).toBe(true);
    expect(events("purchase")).toHaveLength(0); // tags not ready yet: nothing lost, nothing sent early
    await a.initAnalytics();
    await new Promise((r) => setTimeout(r, 20));
    expect(events("purchase")).toHaveLength(1);
    const conv = events("conversion");
    expect(conv).toHaveLength(1);
    expect(conv[0][2].send_to).toBe("AW-123456789/LBL");
    expect(conv[0][2].transaction_id).toBe("AWH-2026-ABC234");
    expect(fbq).toHaveBeenCalledWith("track", "Purchase", expect.anything(), { eventID: "order_AWH-2026-ABC234" });
  });

  it("never fires twice for the same order (refresh, reopen)", async () => {
    const a = await load();
    await a.initAnalytics();
    expect(a.trackPurchase(order)).toBe(true);
    expect(a.trackPurchase(order)).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(events("purchase")).toHaveLength(1);
    expect(events("conversion")).toHaveLength(1);
  });

  it("counts one begin_checkout when cart and checkout both report it", async () => {
    const a = await load();
    await a.initAnalytics();
    const items = [{ id: "p1", name: "Bracelet", price: 750, quantity: 1 }];
    a.trackBeginCheckout(items, 829);
    a.trackBeginCheckout(items, 829);
    expect(events("begin_checkout")).toHaveLength(1);
  });
});
