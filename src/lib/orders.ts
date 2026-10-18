
export type OrderItemRow = {
  id?: string;
  product_id?: string | null;
  product_name: string;
  product_image?: string | null;
  quantity: number;
  price: number;
  subtotal?: number;
  variant?: string | null;
};

export type StatusHistoryRow = {
  id?: string;
  old_status?: string | null;
  new_status?: string | null;
  status?: string | null;
  note?: string | null;
  changed_by?: string | null;
  changed_at: string;
};

export type AdminOrderRow = {
  id: string;
  order_number: string | null;
  created_at: string;
  updated_at?: string | null;
  user_id: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  subtotal: number;
  shipping: number;
  discount: number;
  total: number;
  status: string | null;
  payment_status: string | null;
  payment_method: string | null;
  payment_id?: string | null;
  payment_reference?: string | null;
  razorpay_order_id?: string | null;
  courier_name: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  estimated_delivery_date: string | null;
  shipping_note: string | null;
  cancellation_reason: string | null;
  notes?: string | null;
  items: unknown;
};

export type TrackedOrder = {
  order: {
    id: string;
    order_number: string;
    created_at: string;
    status: string;
    payment_status: string | null;
    payment_method: string | null;
    customer_name: string;
    customer_phone?: string;
    address: string | null;
    city: string | null;
    state: string | null;
    pincode: string | null;
    subtotal: number;
    shipping: number;
    discount: number;
    total: number;
    courier_name: string | null;
    tracking_number: string | null;
    tracking_url: string | null;
    estimated_delivery_date: string | null;
    shipping_note: string | null;
    cancellation_reason: string | null;
  };
  items: OrderItemRow[];
  history: StatusHistoryRow[];
};

/**
 * Order tracking goes through the server only: it needs the order number plus the phone number
 * or email used at checkout, and returns just what this page needs.
 */
export const trackOrderLookup = async (orderNumber: string, contact: string) => {
  try {
    const res = await fetch(`/api/tracking/lookup?q=${encodeURIComponent(orderNumber)}&phone=${encodeURIComponent(contact)}`);
    if (res.ok) {
      const json = await res.json();
      if (json.order) {
        return {
          error: null,
          data: { order: json.order, items: itemsFromOrder(json.order), history: json.order.history || [] } as TrackedOrder,
        };
      }
    }
    if (res.status === 400) return { error: "invalid_input", data: null };
    if (res.status === 404) return { error: "order_not_found", data: null };
  } catch (e) {
    console.warn("Tracking lookup note:", e);
  }
  return { error: "server", data: null };
};

export const itemsFromOrder = (order: { items?: unknown }): OrderItemRow[] =>
  Array.isArray(order.items)
    ? (order.items as any[]).map((i) => ({
        product_id: i.id ?? i.product_id ?? null,
        product_name: i.name ?? i.product_name ?? "Item",
        product_image: i.image_url ?? i.product_image ?? i.image ?? null,
        quantity: Number(i.quantity ?? 1),
        price: Number(i.price ?? 0),
        subtotal: Number(i.price ?? 0) * Number(i.quantity ?? 1),
        variant: i.variant ?? null,
      }))
    : [];
