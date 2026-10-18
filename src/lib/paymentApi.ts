/** Client for the payment API (Netlify Functions). Prices are never sent: the server computes them. */

export type PaidOrder = {
  order_id: string;
  order_number: string | null;
  status: string;
  payment_status: "created" | "paid" | "failed" | "refunded" | string;
  payment_method: string | null;
  payment_id: string | null;
  failure_reason: string | null;
  payment_attempts?: number;
  paid_at: string | null;
  created_at: string;
  customer_name: string;
  customer_phone: string;
  customer_email: string | null;
  items: { id?: string; name: string; price: number; quantity: number; variant?: string | null; image_url?: string | null }[];
  subtotal: number;
  discount: number;
  shipping: number;
  total: number;
  currency: string;
};

export type CreatedOrder = {
  order_id: string;
  order_number: string;
  razorpay_order_id: string;
  key_id: string;
  amount: number;
  currency: string;
  total: number;
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const call = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, "Network problem. Please check your connection and try again.");
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON response */
  }
  if (!res.ok || !data) {
    throw new ApiError(res.status, data?.error || data?.message || `Request failed (${res.status})`);
  }
  return data as T;
};

export const createPaymentOrder = (body: {
  items: { id: string; quantity: number; variant?: string | null }[];
  customer: { name: string; phone: string; email: string };
  address: { address: string; city: string; state: string; pincode: string };
}, idToken?: string | null) =>
  call<CreatedOrder>("/api/payments/create-order", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
    body: JSON.stringify(body),
  });

/**
 * Asks the server what Razorpay really says about this order's payment attempts. The server reads
 * Razorpay itself: a captured payment becomes "paid", failed attempts are stored with their reason.
 */
export const checkAttempt = (orderId: string) =>
  call<PaidOrder & { success: boolean }>("/api/payments/check-attempt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_id: orderId }),
  });

/** Shown instead of Razorpay's technical text when payments are blocked for this website address. */
export const NOT_ENABLED_MESSAGE = "Payments are not enabled for this website address yet. Please contact us on WhatsApp.";

export const friendlyFailure = (reason: string | null | undefined, code?: string | null) =>
  /does not match registered website|payment_risk_check_failed/i.test(`${reason ?? ""} ${code ?? ""}`) ? NOT_ENABLED_MESSAGE : reason ?? null;

export const verifyPaymentOnServer = (body: {
  order_id: string;
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}) =>
  call<PaidOrder & { success: boolean }>("/api/payments/verify-payment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const fetchOrderStatus = (orderId: string) =>
  call<PaidOrder & { success: boolean }>(`/api/payments/order-status?order_id=${encodeURIComponent(orderId)}`);
