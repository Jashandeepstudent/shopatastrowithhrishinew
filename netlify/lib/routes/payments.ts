import crypto from "node:crypto";
import type { DocumentReference, Firestore } from "firebase-admin/firestore";
import { getDb } from "../firebaseAdmin";
import { optionalUser } from "../auth";
import { HttpError, json, readJson } from "../http";
import { computeTotals } from "../pricing";
import {
  applyPaymentChange,
  buildOrderDoc,
  deductStockOnce,
  getOrderRef,
  newOrderIds,
  parseCustomer,
  receiptView,
  statusOnlyView,
  type OrderDoc,
} from "../orders";
import {
  gateway,
  getRazorpay,
  isRazorpayId,
  publicKeyId,
  verifyCheckoutSignature,
  verifyWebhookSignature,
} from "../razorpay";

const ORDER_ID_RE = /^ord_[a-f0-9]{24}$/;
const RECONCILE_INTERVAL_MS = 10_000;
const RECONCILE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/* ─── GET /api/payments/config ─── */
export const paymentConfig = async () => {
  const keyId = publicKeyId();
  return json(200, {
    success: true,
    razorpay_enabled: true,
    has_razorpay: true,
    razorpay_key_id: keyId,
    is_live: keyId.startsWith("rzp_live_"),
    test_mode: false,
    cod_enabled: false,
  });
};

/* ─── POST /api/payments/create-order ─── */
export const createOrder = async (req: Request) => {
  const user = await optionalUser(req);
  const body = await readJson(req);
  const customer = parseCustomer(body.customer, body.address);
  const db = getDb();
  // Browser prices, test_mode and is_test are deliberately ignored.
  const totals = await computeTotals(db, body.items, body.couponCode ?? body.coupon_code);
  const { id, orderNumber } = await newOrderIds(db);

  let razorpayOrder: { id: string };
  try {
    razorpayOrder = (await gateway(getRazorpay().orders.create({
      amount: totals.total * 100,
      currency: "INR",
      receipt: orderNumber,
      notes: { order_number: orderNumber, internal_order_id: id },
    }))) as { id: string };
  } catch (err: any) {
    console.error("[create-order] Razorpay order creation failed:", err?.error?.description || err?.message || err);
    throw new HttpError(502, "Payment gateway is unavailable. Please try again in a moment.");
  }

  const doc = buildOrderDoc({
    id,
    orderNumber,
    userId: user?.uid ?? null,
    customer,
    totals,
    razorpayOrderId: razorpayOrder.id,
  });
  await db.collection("orders").doc(id).create(doc);

  return json(200, {
    success: true,
    order_id: id,
    order_number: orderNumber,
    razorpay_order_id: razorpayOrder.id,
    key_id: publicKeyId(),
    amount: doc.amount_paise,
    currency: "INR",
    subtotal: doc.subtotal,
    discount: doc.discount,
    shipping: doc.shipping,
    total: doc.total,
  });
};

/**
 * Confirms one payment with the Razorpay API and records it. Shared by verify-payment
 * and order-status so both apply identical checks: payment belongs to this order,
 * INR, exact amount, captured (an authorized payment is captured here).
 */
const confirmWithGateway = async (db: Firestore, ref: DocumentReference, order: OrderDoc, paymentId: string, source: string) => {
  const rzp = getRazorpay();
  let payment: any;
  try {
    payment = await gateway(rzp.payments.fetch(paymentId));
  } catch (err: any) {
    if (err?.statusCode === 400 || err?.statusCode === 404) throw new HttpError(400, "Payment not found");
    console.error("[payments] fetch failed:", err?.error?.description || err?.message || err);
    throw new HttpError(502, "Could not reach the payment gateway. Please check again shortly.");
  }

  if (payment.order_id !== order.razorpay_order_id) throw new HttpError(400, "Payment does not belong to this order");
  if (payment.currency !== "INR" || Number(payment.amount) !== order.amount_paise) {
    throw new HttpError(400, "Payment amount does not match the order");
  }

  if (payment.status === "authorized") {
    try {
      payment = await gateway(rzp.payments.capture(paymentId, order.amount_paise, "INR"));
    } catch (err: any) {
      // Auto-capture may have captured it in the meantime; trust only a fresh fetch.
      console.warn("[payments] capture note:", err?.error?.description || err?.message || err);
      payment = await gateway(rzp.payments.fetch(paymentId));
    }
  }

  if (payment.status === "failed") {
    await applyPaymentChange(db, ref, { kind: "failed", paymentId, reason: payment.error_description ?? null }, source);
    throw new HttpError(402, payment.error_description || "Payment failed");
  }
  if (payment.status !== "captured") throw new HttpError(409, "Payment is not complete yet");

  const result = await applyPaymentChange(
    db,
    ref,
    { kind: "paid", paymentId, amountPaise: Number(payment.amount), currency: payment.currency, method: payment.method },
    source
  );
  await deductStockOnce(db, ref);
  return result;
};

/* ─── POST /api/payments/verify-payment ─── */
export const verifyPayment = async (req: Request) => {
  const body = await readJson(req);
  const { razorpay_order_id: rzpOrderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = body;

  if (!isRazorpayId("order", rzpOrderId) || !isRazorpayId("pay", paymentId)) {
    throw new HttpError(400, "Missing or invalid payment details");
  }
  if (!verifyCheckoutSignature(rzpOrderId, paymentId, signature)) {
    throw new HttpError(400, "Payment verification failed");
  }

  const db = getDb();
  const ref = await getOrderRef(db, { razorpayOrderId: rzpOrderId });
  if (!ref) throw new HttpError(404, "Order not found");
  if (body.order_id && body.order_id !== ref.id) throw new HttpError(400, "Order does not match payment");

  const order = (await ref.get()).data() as OrderDoc;
  const { order: updated } = await confirmWithGateway(db, ref, order, paymentId, "checkout");
  return json(200, { success: true, ...receiptView(updated) });
};

/** If the order isn't paid yet, look for a captured/authorized payment on its Razorpay order. */
const reconcile = async (db: Firestore, ref: DocumentReference, order: OrderDoc): Promise<OrderDoc> => {
  if (order.payment_status !== "created" && order.payment_status !== "failed") return order;
  if (Date.now() - new Date(order.created_at).getTime() > RECONCILE_MAX_AGE_MS) return order;
  const last = order.last_gateway_check_at ? new Date(order.last_gateway_check_at as string).getTime() : 0;
  if (Date.now() - last < RECONCILE_INTERVAL_MS) return order;

  await ref.update({ last_gateway_check_at: new Date().toISOString() });
  try {
    const payments: any = await gateway(getRazorpay().orders.fetchPayments(order.razorpay_order_id));
    const candidate = (payments?.items ?? []).find((p: any) => p.status === "captured" || p.status === "authorized");
    if (!candidate) return order;
    return (await confirmWithGateway(db, ref, order, candidate.id, "status_check")).order;
  } catch (err: any) {
    console.warn("[order-status] reconcile note:", err?.message || err);
    return ((await ref.get()).data() as OrderDoc) ?? order;
  }
};

/**
 * ─── POST /api/payments/check-attempt ───
 * The page calls this when Razorpay reports a failed payment, and before it shows "cancelled".
 * The server reads every payment attempt on this order from Razorpay (the browser's word is never used):
 *  - a captured or authorized payment goes through the normal checks and the order becomes paid;
 *  - otherwise failed attempts are stored with Razorpay's reason and the attempt count;
 *  - with no attempts at all, nothing changes.
 * An order that is already paid never moves back.
 */
export const checkAttempt = async (req: Request) => {
  const body = await readJson(req);
  const orderId = String(body.order_id ?? "").trim();
  if (!ORDER_ID_RE.test(orderId)) throw new HttpError(400, "A valid order_id is required");

  const db = getDb();
  const ref = await getOrderRef(db, { id: orderId });
  if (!ref) throw new HttpError(404, "Order not found");
  let order = (await ref.get()).data() as OrderDoc;
  if (order.payment_status === "paid" || order.payment_status === "refunded") {
    return json(200, { success: true, ...receiptView(order) });
  }

  // a short pause between checks keeps repeated calls from hammering Razorpay
  const last = order.last_attempt_check_at ? new Date(order.last_attempt_check_at as string).getTime() : 0;
  if (Date.now() - last < 2000) return json(200, { success: true, ...receiptView(order) });
  await ref.update({ last_attempt_check_at: new Date().toISOString() });

  let items: any[];
  try {
    const result: any = await gateway(getRazorpay().orders.fetchPayments(order.razorpay_order_id));
    items = result?.items ?? [];
  } catch (err: any) {
    console.error("[check-attempt] gateway read failed:", err?.error?.description || err?.message || err);
    throw new HttpError(502, "Could not reach the payment gateway. Please check again shortly.");
  }

  const good = items.find((p) => p.status === "captured" || p.status === "authorized");
  if (good) {
    order = (await confirmWithGateway(db, ref, order, good.id, "attempt_check")).order;
  } else {
    const failed = items.filter((p) => p.status === "failed").sort((a, b) => Number(b.created_at) - Number(a.created_at));
    if (failed.length) {
      const latest = failed[0];
      const reason = latest.error_description || latest.error_reason || null;
      order = (await applyPaymentChange(db, ref, { kind: "failed", paymentId: latest.id, reason, attempts: items.length }, "attempt_check")).order;
    }
  }
  return json(200, { success: true, ...receiptView(order) });
};

/* ─── GET /api/payments/order-status ─── */
export const orderStatus = async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const orderId = params.get("order_id")?.trim() || null;
  const rzpOrderId = params.get("razorpay_order_id")?.trim() || null;
  const orderNumber = params.get("order_number")?.trim().toUpperCase() || null;
  const db = getDb();

  // The unguessable ids unlock the receipt; the short order number shows status only.
  if ((orderId && ORDER_ID_RE.test(orderId)) || isRazorpayId("order", rzpOrderId)) {
    const ref = await getOrderRef(db, {
      id: orderId && ORDER_ID_RE.test(orderId) ? orderId : null,
      razorpayOrderId: isRazorpayId("order", rzpOrderId) ? rzpOrderId : null,
    });
    if (!ref) throw new HttpError(404, "Order not found");
    const order = await reconcile(db, ref, (await ref.get()).data() as OrderDoc);
    return json(200, { success: true, ...receiptView(order) });
  }

  if (orderNumber && /^AWH-\d{4}-[A-Z0-9]{6}$/.test(orderNumber)) {
    const ref = await getOrderRef(db, { orderNumber });
    if (!ref) throw new HttpError(404, "Order not found");
    return json(200, { success: true, ...statusOnlyView((await ref.get()).data() as OrderDoc) });
  }

  throw new HttpError(400, "order_id, razorpay_order_id or order_number is required");
};

/* ─── POST /api/payments/webhook ─── */
export const webhook = async (req: Request) => {
  const raw = await req.text();
  if (!verifyWebhookSignature(raw, req.headers.get("x-razorpay-signature"))) {
    return json(400, { error: "Invalid signature" });
  }

  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const db = getDb();
  const eventId =
    req.headers.get("x-razorpay-event-id") || `sha256_${crypto.createHash("sha256").update(raw).digest("hex")}`;
  const eventRef = db.collection("payment_events").doc(eventId.replace(/\//g, "_"));
  if ((await eventRef.get()).exists) return json(200, { status: "duplicate" });

  const type = String(event?.event ?? "unknown");
  const payment = event?.payload?.payment?.entity ?? null;
  const rzpOrderId: string | null = payment?.order_id ?? event?.payload?.order?.entity?.id ?? null;
  const ref = rzpOrderId ? await getOrderRef(db, { razorpayOrderId: rzpOrderId }) : null;
  let outcome = ref ? "ignored" : "order_not_found";

  if (ref && payment) {
    try {
      if ((type === "payment.captured" || type === "order.paid") && payment.status === "captured") {
        const { changed } = await applyPaymentChange(
          db,
          ref,
          { kind: "paid", paymentId: payment.id, amountPaise: Number(payment.amount), currency: payment.currency, method: payment.method },
          "webhook"
        );
        await deductStockOnce(db, ref);
        outcome = changed ? "marked_paid" : "no_change";
      } else if (type === "payment.failed") {
        const { changed } = await applyPaymentChange(
          db,
          ref,
          { kind: "failed", paymentId: payment.id, reason: payment.error_description ?? null },
          "webhook"
        );
        outcome = changed ? "marked_failed" : "no_change";
      } else if (type === "refund.processed") {
        const refunded = Number(payment.amount_refunded ?? event?.payload?.refund?.entity?.amount ?? 0);
        const { changed } = await applyPaymentChange(db, ref, { kind: "refunded", paymentId: payment.id, amountRefundedPaise: refunded }, "webhook");
        outcome = changed ? "refund_recorded" : "no_change";
      }
    } catch (err) {
      // A mismatch will never succeed on retry, so record it and acknowledge.
      if (err instanceof HttpError && err.status === 400) {
        console.error(`[webhook] ${type} rejected for ${rzpOrderId}: ${err.message}`);
        outcome = "rejected_mismatch";
      } else {
        throw err; // 500 -> Razorpay retries
      }
    }
  }

  await eventRef.set({
    event_type: type,
    razorpay_order_id: rzpOrderId,
    payment_id: payment?.id ?? null,
    order_id: ref?.id ?? null,
    outcome,
    received_at: new Date().toISOString(),
  });
  return json(200, { status: "ok", outcome });
};
