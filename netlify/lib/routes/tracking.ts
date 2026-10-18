import { getDb } from "../firebaseAdmin";
import { HttpError, json } from "../http";
import { getOrderRef, normalizePhone, trackingView, type OrderDoc } from "../orders";

const NOT_FOUND = "No order found with these details. Please check the order number and phone/email.";

/* ─── GET /api/tracking/lookup?q=<order number>&phone=<phone or email> ─── */
export const trackingLookup = async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const q = (params.get("q") ?? "").trim();
  const contact = (params.get("phone") ?? params.get("contact") ?? "").trim().toLowerCase();
  if (!q || !contact) throw new HttpError(400, "Order number and phone number or email are required");

  const orderNumber = q.toUpperCase();
  const db = getDb();
  const ref = /^AWH-\d{4}-[A-Z0-9]{6}$/.test(orderNumber)
    ? await getOrderRef(db, { orderNumber })
    : /^ord_[a-f0-9]{24}$/.test(q)
      ? await getOrderRef(db, { id: q })
      : null;
  if (!ref) throw new HttpError(404, NOT_FOUND);

  const order = (await ref.get()).data() as OrderDoc;
  const matches = contact.includes("@")
    ? Boolean(order.customer_email) && order.customer_email === contact
    : normalizePhone(contact).length === 10 && normalizePhone(contact) === normalizePhone(order.customer_phone);
  // Same response for "not found" and "wrong contact" so order numbers can't be probed.
  if (!matches) throw new HttpError(404, NOT_FOUND);

  return json(200, { order: trackingView(order) });
};

/* ─── GET /api/tracking/config (public analytics IDs only) ─── */
export const trackingConfig = async () => {
  const config = {
    google_analytics_id: process.env.VITE_GA_MEASUREMENT_ID || "",
    meta_pixel_id: process.env.VITE_META_PIXEL_ID || "",
    google_ads_id: process.env.VITE_GOOGLE_ADS_ID || "",
    google_ads_conversion_label: process.env.VITE_GOOGLE_ADS_CONVERSION_LABEL || "",
    google_site_verification: process.env.VITE_GOOGLE_SITE_VERIFICATION || "",
    gtm_id: process.env.VITE_GTM_ID || "",
    enabled: true,
  };
  try {
    const snap = await getDb().collection("settings").doc("tracking").get();
    const data = snap.data();
    if (data) {
      for (const key of Object.keys(config) as (keyof typeof config)[]) {
        if (key === "enabled") config.enabled = data.enabled !== false;
        else if (typeof data[key] === "string" && data[key]) config[key] = data[key];
      }
    }
  } catch (err: any) {
    console.warn("[tracking-config] settings read note:", err?.message || err);
  }
  return json(200, { success: true, config });
};
