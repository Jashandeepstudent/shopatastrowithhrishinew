import type { Firestore } from "firebase-admin/firestore";
import { CATALOG } from "../../src/lib/catalog";
import { shippingFor } from "../../src/lib/shop";
import { HttpError } from "./http";

/*
 * Server-side order pricing. The browser's prices, test_mode / is_test flags and
 * test products are ignored or rejected; every amount comes from the catalog
 * (built-in CATALOG merged with admin edits in Firestore `products`, the same
 * merge the shop uses) and Firestore `coupons`.
 */

export const MAX_LINE_ITEMS = 20;
export const MAX_QUANTITY = 10;

export type PricedItem = {
  id: string;
  name: string;
  price: number;
  quantity: number;
  variant: string | null;
  image_url: string | null;
};

export type OrderTotals = {
  items: PricedItem[];
  subtotal: number;
  discount: number;
  coupon_code: string | null;
  shipping: number;
  total: number;
};

/** Payment-test products are not sellable (client decision: no Rs 10 test option). */
const isTestProduct = (id: string, name: string, category: unknown) =>
  id.startsWith("live-payment-test") ||
  category === "test" ||
  /live payment test|payment test ₹/i.test(name);

type ProductRecord = {
  id: string;
  name?: string;
  price?: unknown;
  active?: unknown;
  category?: unknown;
  stock?: unknown;
  image_url?: string | null;
  variants?: { name: string; options: string[] }[] | null;
};

const loadProduct = async (db: Firestore, id: string): Promise<ProductRecord | null> => {
  const builtIn = CATALOG.find((p) => p.id === id);
  const snap = await db.collection("products").doc(id).get();
  if (!builtIn && !snap.exists) return null;
  return { ...(builtIn ?? {}), ...(snap.exists ? snap.data() : {}), id } as ProductRecord;
};

const parseQuantity = (raw: unknown) => {
  const q = Number(raw);
  if (!Number.isInteger(q) || q < 1 || q > MAX_QUANTITY) {
    throw new HttpError(400, `Quantity must be a whole number from 1 to ${MAX_QUANTITY}`);
  }
  return q;
};

const parseVariant = (raw: unknown, product: ProductRecord): string | null => {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = String(raw);
  const options = (product.variants ?? []).flatMap((v) => v.options ?? []);
  if (!options.includes(value)) throw new HttpError(400, `Invalid option for ${product.name ?? "product"}`);
  return value;
};

export const priceItems = async (db: Firestore, rawItems: unknown): Promise<PricedItem[]> => {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new HttpError(400, "Cart is empty");
  if (rawItems.length > MAX_LINE_ITEMS) throw new HttpError(400, "Too many items in cart");

  const priced: PricedItem[] = [];
  for (const raw of rawItems) {
    const id = String(raw?.id ?? raw?.product_id ?? "").trim();
    if (!id) throw new HttpError(400, "Each item needs a product id");

    const product = await loadProduct(db, id);
    const name = String(product?.name ?? "");
    const price = Number(product?.price);
    if (
      !product ||
      product.active === false ||
      isTestProduct(id, name, product.category) ||
      !Number.isFinite(price) ||
      price <= 0
    ) {
      throw new HttpError(400, "One or more items in your cart are no longer available");
    }

    const quantity = parseQuantity(raw?.quantity);
    if (typeof product.stock === "number" && product.stock < quantity) {
      throw new HttpError(409, `"${name}" has only ${Math.max(0, product.stock)} left in stock`);
    }

    priced.push({
      id,
      name,
      price: Math.round(price),
      quantity,
      variant: parseVariant(raw?.variant, product),
      image_url: product.image_url ?? null,
    });
  }
  return priced;
};

// Retired by client decision. Refused even if a document with this code still exists in Firestore.
const RETIRED_COUPONS = new Set(["FIRST3FREE"]);

const couponDiscount = async (db: Firestore, rawCode: unknown, subtotal: number) => {
  if (rawCode === undefined || rawCode === null || String(rawCode).trim() === "") {
    return { discount: 0, code: null };
  }
  const code = String(rawCode).trim().toUpperCase();
  if (RETIRED_COUPONS.has(code)) throw new HttpError(400, "Invalid or expired coupon");
  const snap = await db.collection("coupons").where("code", "==", code).limit(1).get();
  const coupon = snap.empty ? null : snap.docs[0].data();

  const expired = coupon?.expires_at && new Date(coupon.expires_at).getTime() < Date.now();
  const usedUp =
    coupon?.usage_limit != null && Number(coupon.used_count ?? 0) >= Number(coupon.usage_limit);
  if (!coupon || coupon.active === false || expired || usedUp) throw new HttpError(400, "Invalid or expired coupon");
  if (subtotal < Number(coupon.min_order ?? 0)) {
    throw new HttpError(400, `Coupon needs a minimum order of Rs ${Number(coupon.min_order)}`);
  }

  const value = Number(coupon.discount_value ?? 0);
  let discount = coupon.discount_type === "percent" ? (subtotal * value) / 100 : value;
  if (coupon.max_discount) discount = Math.min(discount, Number(coupon.max_discount));
  discount = Math.max(0, Math.min(Math.round(discount), subtotal));
  return { discount, code };
};

export const computeTotals = async (db: Firestore, rawItems: unknown, rawCoupon: unknown): Promise<OrderTotals> => {
  const items = await priceItems(db, rawItems);
  const subtotal = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
  const { discount, code } = await couponDiscount(db, rawCoupon, subtotal);
  const shipping = shippingFor(subtotal);
  const total = subtotal - discount + shipping;
  if (total < 1) throw new HttpError(400, "Order total must be at least Rs 1");
  return { items, subtotal, discount, coupon_code: code, shipping, total };
};
