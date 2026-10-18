import crypto from "node:crypto";
import type { DocumentReference, Firestore } from "firebase-admin/firestore";
import { HttpError } from "./http";
import type { OrderTotals } from "./pricing";

/*
 * Order documents live in Firestore `orders` and are written only by these functions.
 *
 * Two status fields:
 *  - payment_status: "created" -> "paid" | "failed";  "failed" -> "paid";  "paid" -> "refunded".
 *    It only ever moves forward; a late failure or duplicate event never undoes "paid".
 *  - status: fulfilment lifecycle, same vocabulary as src/lib/orderStatus.ts
 *    ("placed", "payment_confirmed", ... "payment_failed", "refunded").
 */

export type PaymentStatus = "created" | "paid" | "failed" | "refunded";

export type HistoryEntry = {
  status: string;
  note: string;
  changed_by: string;
  changed_at: string;
};

export type OrderDoc = {
  id: string;
  order_number: string;
  user_id: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  country: string;
  notes: string | null;
  items: OrderTotals["items"];
  subtotal: number;
  discount: number;
  coupon_code: string | null;
  shipping: number;
  total: number;
  amount_paise: number;
  currency: "INR";
  status: string;
  payment_status: PaymentStatus;
  payment_method: "razorpay";
  razorpay_order_id: string;
  payment_id: string | null;
  paid_at: string | null;
  inventory_deducted: boolean;
  history: HistoryEntry[];
  created_at: string;
  updated_at: string;
  [extra: string]: unknown;
};

const now = () => new Date().toISOString();

/* ─── Customer input validation ─── */

const text = (raw: unknown, field: string, min: number, max: number) => {
  const value = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (value.length < min || value.length > max) throw new HttpError(400, `Please enter a valid ${field}`);
  return value;
};

export const normalizePhone = (raw: unknown) => {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
};

export const parseCustomer = (customer: any, address: any) => {
  const phone = normalizePhone(customer?.phone);
  if (!/^[6-9]\d{9}$/.test(phone)) throw new HttpError(400, "Please enter a valid 10-digit mobile number");

  const rawEmail = String(customer?.email ?? "").trim().toLowerCase();
  if (rawEmail && (rawEmail.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail))) {
    throw new HttpError(400, "Please enter a valid email address");
  }

  const pincode = String(address?.pincode ?? "").trim();
  if (!/^\d{6}$/.test(pincode)) throw new HttpError(400, "Please enter a valid 6-digit pincode");

  const notes = String(address?.notes ?? "").trim();
  return {
    customer_name: text(customer?.name, "name", 2, 80),
    customer_email: rawEmail || null,
    customer_phone: phone,
    address: text(address?.address, "address", 5, 300),
    city: text(address?.city, "city", 2, 60),
    state: text(address?.state, "state", 2, 60),
    pincode,
    country: "India",
    notes: notes ? notes.slice(0, 300) : null,
  };
};

/* ─── Creation and lookup ─── */

const ORDER_NUMBER_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const randomOrderNumber = () => {
  const bytes = crypto.randomBytes(6);
  const suffix = Array.from(bytes, (b) => ORDER_NUMBER_CHARS[b % ORDER_NUMBER_CHARS.length]).join("");
  return `AWH-${new Date().getFullYear()}-${suffix}`;
};

export const newOrderIds = async (db: Firestore) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const orderNumber = randomOrderNumber();
    const clash = await db.collection("orders").where("order_number", "==", orderNumber).limit(1).get();
    if (clash.empty) {
      // Unguessable document id: it is what unlocks the receipt view.
      return { id: `ord_${crypto.randomBytes(12).toString("hex")}`, orderNumber };
    }
  }
  throw new Error("Could not allocate a unique order number");
};

export const buildOrderDoc = (args: {
  id: string;
  orderNumber: string;
  userId: string | null;
  customer: ReturnType<typeof parseCustomer>;
  totals: OrderTotals;
  razorpayOrderId: string;
}): OrderDoc => {
  const ts = now();
  return {
    id: args.id,
    order_number: args.orderNumber,
    user_id: args.userId,
    ...args.customer,
    items: args.totals.items,
    subtotal: args.totals.subtotal,
    discount: args.totals.discount,
    coupon_code: args.totals.coupon_code,
    shipping: args.totals.shipping,
    total: args.totals.total,
    amount_paise: args.totals.total * 100,
    currency: "INR",
    status: "placed",
    payment_status: "created",
    payment_method: "razorpay",
    razorpay_order_id: args.razorpayOrderId,
    payment_id: null,
    paid_at: null,
    inventory_deducted: false,
    history: [{ status: "placed", note: "Order created, awaiting payment", changed_by: "system", changed_at: ts }],
    created_at: ts,
    updated_at: ts,
  };
};

export const getOrderRef = async (
  db: Firestore,
  by: { id?: string | null; razorpayOrderId?: string | null; orderNumber?: string | null }
): Promise<DocumentReference | null> => {
  if (by.id) {
    const ref = db.collection("orders").doc(by.id);
    if ((await ref.get()).exists) return ref;
  }
  const field = by.razorpayOrderId ? "razorpay_order_id" : by.orderNumber ? "order_number" : null;
  const value = by.razorpayOrderId || by.orderNumber;
  if (!field || !value) return null;
  const snap = await db.collection("orders").where(field, "==", value).limit(1).get();
  return snap.empty ? null : snap.docs[0].ref;
};

/* ─── Payment state changes (forward only, idempotent) ─── */

export type PaymentChange =
  | { kind: "paid"; paymentId: string; amountPaise: number; currency: string; method?: string | null }
  | { kind: "failed"; paymentId?: string | null; reason?: string | null; attempts?: number }
  | { kind: "refunded"; paymentId?: string | null; amountRefundedPaise: number };

export type ChangeResult = { order: OrderDoc; changed: boolean };

/**
 * Applies a verified payment event inside a transaction. Callers must already have
 * verified the event (signature and/or Razorpay API); this function enforces the
 * amount/currency match and the forward-only rules.
 */
export const applyPaymentChange = async (
  db: Firestore,
  ref: DocumentReference,
  change: PaymentChange,
  source: string
): Promise<ChangeResult> =>
  db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpError(404, "Order not found");
    const order = snap.data() as OrderDoc;
    const ts = now();
    const history = [...(order.history ?? [])];
    let update: Partial<OrderDoc> | null = null;

    if (change.kind === "paid") {
      if (change.currency !== "INR" || change.amountPaise !== order.amount_paise) {
        throw new HttpError(400, "Payment amount does not match the order");
      }
      if (order.payment_status === "paid" || order.payment_status === "refunded") {
        if (order.payment_id !== change.paymentId) {
          // A second, separate payment for an already-paid order: keep it visible for a manual refund.
          const extra = (order.extra_payment_ids as string[] | undefined) ?? [];
          if (!extra.includes(change.paymentId)) {
            tx.update(ref, { extra_payment_ids: [...extra, change.paymentId], updated_at: ts });
            console.warn(`[orders] duplicate payment ${change.paymentId} for ${order.order_number}`);
          }
        }
        return { order, changed: false };
      }
      const status = ["placed", "payment_failed"].includes(order.status) ? "payment_confirmed" : order.status;
      history.push({
        status,
        note: `Payment ${change.paymentId} confirmed (${source})`,
        changed_by: source,
        changed_at: ts,
      });
      update = {
        payment_status: "paid",
        status,
        payment_id: change.paymentId,
        payment_method_detail: change.method ?? null,
        paid_at: ts,
        failure_reason: null,
      };
    } else if (change.kind === "failed") {
      if (order.payment_status !== "created" && order.payment_status !== "failed") return { order, changed: false };
      // the same report again (same reason, same number of attempts) changes nothing
      if (
        order.payment_status === "failed" &&
        (order.failure_reason ?? null) === (change.reason ?? null) &&
        (change.attempts === undefined || order.payment_attempts === change.attempts)
      ) {
        return { order, changed: false };
      }
      const status = order.status === "placed" ? "payment_failed" : order.status;
      history.push({
        status,
        note: `Payment failed${change.reason ? `: ${change.reason}` : ""}`,
        changed_by: source,
        changed_at: ts,
      });
      update = {
        payment_status: "failed",
        status,
        failure_reason: change.reason ?? null,
        payment_attempts: change.attempts ?? (order.payment_attempts as number | undefined) ?? 1,
        last_failed_payment_id: change.paymentId ?? null,
      };
    } else {
      if (order.payment_status !== "paid") return { order, changed: false };
      if (change.amountRefundedPaise < order.amount_paise) {
        update = { refunded_paise: change.amountRefundedPaise };
        history.push({
          status: order.status,
          note: `Partial refund of Rs ${change.amountRefundedPaise / 100}`,
          changed_by: source,
          changed_at: ts,
        });
      } else {
        history.push({ status: "refunded", note: "Payment fully refunded", changed_by: source, changed_at: ts });
        update = { payment_status: "refunded", status: "refunded", refunded_paise: change.amountRefundedPaise };
      }
    }

    const next = { ...order, ...update, history, updated_at: ts } as OrderDoc;
    tx.update(ref, { ...update, history, updated_at: ts });
    return { order: next, changed: true };
  });

/** Reduces stock once per paid order. Products without a numeric stock are untracked. */
export const deductStockOnce = async (db: Firestore, ref: DocumentReference) => {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const order = snap.data() as OrderDoc | undefined;
    if (!order || order.inventory_deducted || order.payment_status !== "paid") return;
    const productRefs = order.items.map((i) => db.collection("products").doc(i.id));
    const products = productRefs.length ? await tx.getAll(...productRefs) : [];
    products.forEach((p, idx) => {
      const stock = p.exists ? p.data()?.stock : undefined;
      if (typeof stock === "number") {
        tx.update(p.ref, { stock: Math.max(0, stock - order.items[idx].quantity), updated_at: now() });
      }
    });
    tx.update(ref, { inventory_deducted: true });
  });
};

/* ─── Public views (never return more than the page needs) ─── */

const viewItems = (order: OrderDoc) =>
  (order.items ?? []).map((i) => ({
    id: i.id,
    name: i.name,
    price: i.price,
    quantity: i.quantity,
    variant: i.variant ?? null,
    image_url: i.image_url ?? null,
  }));

/** For the payment result screen and receipt. Only returned to holders of the unguessable order id. */
export const receiptView = (order: OrderDoc) => ({
  id: order.id,
  order_id: order.id,
  order_number: order.order_number,
  status: order.status,
  payment_status: order.payment_status,
  // the real method used at Razorpay (card, upi, netbanking...) when known, else the gateway name
  payment_method: ((order as any).payment_method_detail as string | null | undefined) ?? order.payment_method,
  payment_id: order.payment_id,
  failure_reason: (order.failure_reason as string | null | undefined) ?? null,
  payment_attempts: (order.payment_attempts as number | undefined) ?? 0,
  paid_at: order.paid_at,
  created_at: order.created_at,
  customer_name: order.customer_name,
  customer_phone: order.customer_phone,
  customer_email: order.customer_email,
  items: viewItems(order),
  subtotal: order.subtotal,
  discount: order.discount,
  shipping: order.shipping,
  total: order.total,
  currency: order.currency,
});

/** Lookup by the short order number alone: no personal data. */
export const statusOnlyView = (order: OrderDoc) => ({
  order_number: order.order_number,
  status: order.status,
  payment_status: order.payment_status,
});

const maskPhone = (phone: string) => (phone.length >= 10 ? `${phone.slice(0, 2)}******${phone.slice(-2)}` : "");

/** For /track-order after order number + matching phone/email. */
export const trackingView = (order: OrderDoc) => ({
  id: order.id,
  order_number: order.order_number,
  created_at: order.created_at,
  status: order.status,
  payment_status: order.payment_status,
  // the real method used at Razorpay (card, upi, netbanking...) when known, else the gateway name
  payment_method: ((order as any).payment_method_detail as string | null | undefined) ?? order.payment_method,
  payment_id: order.payment_status === "paid" ? order.payment_id : null,
  paid_at: order.paid_at,
  customer_name: order.customer_name,
  customer_phone: maskPhone(order.customer_phone),
  city: order.city,
  state: order.state,
  pincode: order.pincode,
  items: viewItems(order),
  subtotal: order.subtotal,
  shipping: order.shipping,
  discount: order.discount,
  total: order.total,
  courier_name: (order.courier_name as string | null | undefined) ?? null,
  tracking_number: (order.tracking_number as string | null | undefined) ?? null,
  tracking_url: (order.tracking_url as string | null | undefined) ?? null,
  estimated_delivery_date: (order.estimated_delivery_date as string | null | undefined) ?? null,
  shipping_note: (order.shipping_note as string | null | undefined) ?? null,
  cancellation_reason: (order.cancellation_reason as string | null | undefined) ?? null,
  history: (order.history ?? []).map((h: any) => ({
    status: h.status ?? h.new_status ?? null,
    new_status: h.new_status ?? h.status ?? null,
    old_status: h.old_status ?? null,
    note: h.note ?? null,
    changed_at: h.changed_at,
  })),
});
