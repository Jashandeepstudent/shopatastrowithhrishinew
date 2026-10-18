import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { AlertTriangle, ArrowLeft, Loader2, Lock, MessageCircle, RotateCcw, ShieldCheck, XCircle } from "lucide-react";
import { toast } from "sonner";
import SEO from "@/components/SEO";
import PageLayout from "@/components/PageLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/useAuth";
import { useCart, type CartItem } from "@/lib/cart";
import { inr, shippingFor } from "@/lib/shop";
import { trackBeginCheckout, trackAddPaymentInfo } from "@/lib/analytics";
import { waLink } from "@/lib/whatsapp";
import {
  ApiError,
  NOT_ENABLED_MESSAGE,
  checkAttempt,
  createPaymentOrder,
  fetchOrderStatus,
  friendlyFailure,
  verifyPaymentOnServer,
  type CreatedOrder,
  type PaidOrder,
} from "@/lib/paymentApi";

declare global {
  interface Window {
    Razorpay?: any;
  }
}

const RAZORPAY_SCRIPT = "https://checkout.razorpay.com/v1/checkout.js";
const PENDING_KEY = "awh_pending_order";

const STATES = [
  "Andhra Pradesh","Arunachal Pradesh","Assam","Bihar","Chhattisgarh","Goa","Gujarat","Haryana",
  "Himachal Pradesh","Jharkhand","Karnataka","Kerala","Madhya Pradesh","Maharashtra","Manipur",
  "Meghalaya","Mizoram","Nagaland","Odisha","Punjab","Rajasthan","Sikkim","Tamil Nadu","Telangana",
  "Tripura","Uttar Pradesh","Uttarakhand","West Bengal","Delhi","Jammu and Kashmir","Ladakh",
  "Chandigarh","Puducherry","Andaman and Nicobar Islands","Dadra and Nagar Haveli and Daman and Diu",
];

type FormState = {
  full_name: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
};

type Outcome =
  | { kind: "failed"; reason: string | null }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

const loadRazorpay = () =>
  new Promise<void>((resolve, reject) => {
    if (window.Razorpay) return resolve();
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${RAZORPAY_SCRIPT}"]`);
    const script = existing ?? Object.assign(document.createElement("script"), { src: RAZORPAY_SCRIPT, async: true });
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () => reject(new Error("Payment window could not load. Please check your connection and try again.")));
    if (!existing) document.body.appendChild(script);
  });

const validate = (f: FormState) => {
  if (f.full_name.trim().length < 2) return "Please enter your full name";
  if (!/^[6-9]\d{9}$/.test(f.phone.replace(/\D/g, "").slice(-10))) return "Please enter a valid 10-digit mobile number";
  if (!/^\S+@\S+\.\S+$/.test(f.email.trim())) return "Please enter a valid email for your receipt";
  if (f.address.trim().length < 5) return "Please enter your complete house/street address";
  if (f.city.trim().length < 2) return "Please enter your city";
  if (!f.state) return "Please select your state";
  if (!/^\d{6}$/.test(f.pincode.trim())) return "Please enter a valid 6-digit pincode";
  return null;
};

const Checkout = () => {
  const nav = useNavigate();
  const loc = useLocation();
  const { firebaseUser } = useAuth();
  const { items } = useCart();

  const [form, setForm] = useState<FormState>({ full_name: "", email: "", phone: "", address: "", city: "", state: "", pincode: "" });
  const [busy, setBusy] = useState<null | "starting" | "verifying">(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // The server-created order is reused for retries so a failed attempt does not create duplicates.
  const sessionRef = useRef<{ order: CreatedOrder; fingerprint: string } | null>(null);
  const settledRef = useRef(false);

  const buyNowItems: CartItem[] = useMemo(() => (loc.state as { items?: CartItem[] } | null)?.items ?? [], [loc.state]);
  const cartItems = items.length > 0 ? items : buyNowItems;
  const subtotal = cartItems.reduce((s, i) => s + i.price * i.quantity, 0);
  const shipping = shippingFor(subtotal);
  const total = subtotal + shipping;

  // Prefill from the saved customer session (read only).
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("awh_customer_session") || localStorage.getItem("awh_customer_session");
      if (!raw) return;
      const s = JSON.parse(raw);
      setForm((f) => ({
        ...f,
        full_name: s.full_name || f.full_name,
        email: s.email || f.email,
        phone: s.phone || f.phone,
        address: s.address || f.address,
        city: s.city || f.city,
        state: s.state || f.state,
        pincode: s.pincode || f.pincode,
      }));
    } catch {
      /* ignore */
    }
  }, []);

  // Returned from a payment app without the page state? Ask the server what happened.
  useEffect(() => {
    let id: string | null = null;
    try {
      id = sessionStorage.getItem(PENDING_KEY);
    } catch {
      /* ignore */
    }
    if (!id) return;
    fetchOrderStatus(id)
      .then((o) => {
        if (o.payment_status === "paid") nav(`/order-success?order=${id}`, { replace: true });
      })
      .catch(() => undefined);
  }, [nav]);

  const trackedRef = useRef(false);
  useEffect(() => {
    if (cartItems.length && !trackedRef.current) {
      trackedRef.current = true;
      trackBeginCheckout(
        cartItems.map((i) => ({ id: i.product_id || i.id, name: i.name, price: i.price, quantity: i.quantity, variant: i.variant ?? null })),
        total
      );
    }
  }, [cartItems, total]);

  const goToResult = (orderId: string) => {
    try {
      sessionStorage.removeItem(PENDING_KEY);
    } catch {
      /* ignore */
    }
    nav(`/order-success?order=${orderId}`, { replace: true });
  };

  const onPaymentSuccess = async (
    order: CreatedOrder,
    response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }
  ) => {
    settledRef.current = true;
    setBusy("verifying");
    try {
      await verifyPaymentOnServer({ order_id: order.order_id, ...response });
      goToResult(order.order_id);
    } catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 409) {
        // The server positively rejected the payment: never show it as paid.
        setBusy(null);
        setOutcome({ kind: "failed", reason: err.message });
        return;
      }
      // Network trouble or gateway not ready: the result page asks the server and keeps checking.
      goToResult(order.order_id);
    }
  };

  // One question to the server (which reads Razorpay itself) before showing "failed" or "cancelled":
  // a payment that really went through, for example when a UPI app was switched, must not look failed.
  const askServer = async (order: CreatedOrder): Promise<PaidOrder | null> => {
    try {
      return await Promise.race([checkAttempt(order.order_id), new Promise<null>((resolve) => setTimeout(() => resolve(null), 9000))]);
    } catch {
      return null;
    }
  };

  const openRazorpay = async (order: CreatedOrder) => {
    await loadRazorpay();
    settledRef.current = false;
    const rzp = new window.Razorpay({
      key: order.key_id,
      order_id: order.razorpay_order_id,
      amount: order.amount,
      currency: order.currency,
      name: "Astro with Hrishi",
      description: `Order ${order.order_number}`,
      image: `${window.location.origin}/assets/brand-logo-light.png`,
      prefill: { name: form.full_name.trim(), email: form.email.trim(), contact: `+91${form.phone.replace(/\D/g, "").slice(-10)}` },
      notes: { order_number: order.order_number },
      theme: { color: "#c9a227" },
      retry: { enabled: true },
      handler: (response: any) => {
        void onPaymentSuccess(order, response);
      },
      modal: {
        ondismiss: () => {
          if (settledRef.current) return;
          void (async () => {
            setBusy("verifying");
            const server = await askServer(order);
            if (settledRef.current) return;
            setBusy(null);
            if (server?.payment_status === "paid") {
              settledRef.current = true;
              goToResult(order.order_id);
              return;
            }
            setOutcome({ kind: "cancelled" });
          })();
        },
      },
    });
    rzp.on("payment.failed", (resp: any) => {
      const raw = resp?.error?.description || resp?.error?.reason || null;
      const code = resp?.error?.reason || resp?.error?.code || null;
      void (async () => {
        setBusy("verifying");
        const server = await askServer(order); // also stores Razorpay's reason and the attempt count
        setBusy(null);
        if (server?.payment_status === "paid") {
          settledRef.current = true;
          goToResult(order.order_id);
          return;
        }
        setOutcome({ kind: "failed", reason: friendlyFailure(raw, code) ?? friendlyFailure(server?.failure_reason) });
      })();
    });
    setBusy(null);
    rzp.open();
  };

  const pay = async () => {
    const problem = validate(form);
    if (problem) return toast.error(problem);
    if (cartItems.length === 0) return;
    setOutcome(null);
    setBusy("starting");
    trackAddPaymentInfo(
      cartItems.map((i) => ({ id: i.product_id || i.id, name: i.name, price: i.price, quantity: i.quantity })),
      total,
      "Razorpay"
    );

    const payload = {
      items: cartItems.map((i) => ({ id: i.product_id || i.id, quantity: i.quantity, variant: i.variant ?? null })),
      customer: { name: form.full_name.trim(), phone: form.phone.replace(/\D/g, "").slice(-10), email: form.email.trim() },
      address: { address: form.address.trim(), city: form.city.trim(), state: form.state, pincode: form.pincode.trim() },
    };
    const fingerprint = JSON.stringify(payload);

    try {
      let session = sessionRef.current;
      if (!session || session.fingerprint !== fingerprint) {
        const token = firebaseUser ? await firebaseUser.getIdToken().catch(() => null) : null;
        const order = await createPaymentOrder(payload, token);
        session = sessionRef.current = { order, fingerprint };
        try {
          sessionStorage.setItem(PENDING_KEY, order.order_id);
        } catch {
          /* ignore */
        }
      }
      await openRazorpay(session.order);
    } catch (err: any) {
      setBusy(null);
      setOutcome({ kind: "error", message: err?.message || "Could not start the payment. Please try again." });
    }
  };

  if (cartItems.length === 0) {
    return (
      <PageLayout title="Checkout">
        <div className="container max-w-md py-32 text-center">
          <h2 className="text-xl font-serif text-cosmic-silver mb-3">Your cart is empty</h2>
          <p className="text-sm text-cosmic-silver/60 mb-6">Explore our energised astrology products and remedies.</p>
          <Button onClick={() => nav("/shop")} className="bg-gradient-gold text-primary-foreground rounded-full px-6">
            Browse Shop
          </Button>
        </div>
      </PageLayout>
    );
  }

  const field = "h-11 bg-background/50 border-gold/30 rounded-xl";
  const label = "text-xs font-medium text-cosmic-silver/80";

  return (
    <PageLayout title="Secure Checkout">
      <SEO title="Secure Checkout — Astro With Hrishi" description="Secure checkout for authentic Vedic crystals and energised remedies." path="/checkout" noindex />

      <div className="container max-w-2xl pt-20 pb-24 px-4">
        <div className="flex items-center justify-between py-3 mb-3 border-b border-gold/15">
          <button type="button" onClick={() => nav(-1)} className="flex items-center gap-1.5 text-sm font-medium text-cosmic-silver hover:text-gold transition-colors">
            <ArrowLeft className="h-4 w-4" />
            <span className="hidden sm:inline">Back</span>
          </button>
          <h2 className="text-sm sm:text-base font-bold tracking-wide uppercase text-foreground">Secure Checkout</h2>
          <div className="px-3 py-1 rounded-full border border-emerald-500/40 bg-emerald-950/40 text-emerald-300 text-xs font-bold tracking-wider flex items-center gap-1">
            <Lock className="h-3 w-3" /> Secure
          </div>
        </div>

        <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
          {outcome && (
            <div role="alert" className="rounded-3xl border border-red-500/40 bg-red-950/30 p-5 space-y-3">
              <div className="flex items-start gap-3">
                {outcome.kind === "cancelled" ? (
                  <XCircle className="h-6 w-6 text-amber-400 shrink-0" />
                ) : (
                  <AlertTriangle className="h-6 w-6 text-red-400 shrink-0" />
                )}
                <div>
                  <h3 className="font-bold text-foreground">
                    {outcome.kind === "cancelled" ? "Payment cancelled" : outcome.kind === "failed" ? "Payment Failed" : "We could not start the payment"}
                  </h3>
                  <p className="text-sm text-cosmic-silver/80 mt-1">
                    {outcome.kind === "cancelled" && "You closed the payment window. You have not been charged."}
                    {outcome.kind === "failed" &&
                      (outcome.reason === NOT_ENABLED_MESSAGE
                        ? outcome.reason
                        : `${outcome.reason || "Your payment could not be completed."} If money was deducted, your bank will refund it.`)}
                    {outcome.kind === "error" && outcome.message}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void pay()} disabled={busy !== null} className="bg-gradient-gold text-primary-foreground font-semibold rounded-xl">
                  <RotateCcw className="h-4 w-4 mr-2" /> Retry Payment
                </Button>
                <Button asChild variant="outline" className="border-gold/30 text-cosmic-silver rounded-xl">
                  <a href={waLink("Hello, I need help with my payment on Astro with Hrishi.")} target="_blank" rel="noreferrer">
                    <MessageCircle className="h-4 w-4 mr-2" /> Need help? WhatsApp us
                  </a>
                </Button>
              </div>
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void pay();
            }}
            className="glass-gold rounded-3xl p-6 sm:p-7 border border-gold/30 shadow-xl space-y-4"
          >
            <h3 className="font-semibold text-sm text-foreground pb-2 border-b border-gold/20">Delivery details</h3>
            <div className="grid sm:grid-cols-2 gap-3.5">
              <div className="space-y-1">
                <label className={label}>Full Name *</label>
                <Input required placeholder="Receiver name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} className={field} />
              </div>
              <div className="space-y-1">
                <label className={label}>10-Digit Mobile *</label>
                <Input required type="tel" inputMode="numeric" maxLength={10} placeholder="9876543210" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={field} />
              </div>
            </div>
            <div className="space-y-1">
              <label className={label}>Email (for receipt &amp; order tracking) *</label>
              <Input required type="email" placeholder="your.email@example.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={field} />
            </div>
            <div className="space-y-1">
              <label className={label}>Flat, House no., Building, Street, Area *</label>
              <Textarea required rows={2} placeholder="E.g. Flat 402, Shivam Residency, MG Road" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className="bg-background/50 border-gold/30 rounded-xl text-sm min-h-[70px]" />
            </div>
            <div className="grid sm:grid-cols-3 gap-3">
              <div className="space-y-1">
                <label className={label}>City *</label>
                <Input required placeholder="Vadodara" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className={field} />
              </div>
              <div className="space-y-1">
                <label className={label}>State *</label>
                <select required value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} className="w-full h-11 rounded-xl bg-background/50 border border-gold/30 px-3 text-xs text-foreground focus:border-gold focus:outline-none">
                  <option value="">Select State</option>
                  {STATES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className={label}>6-Digit Pincode *</label>
                <Input required inputMode="numeric" maxLength={6} placeholder="390022" value={form.pincode} onChange={(e) => setForm({ ...form, pincode: e.target.value })} className={`${field} font-mono`} />
              </div>
            </div>

            <div className="rounded-2xl bg-secondary/50 border border-gold/25 p-4 space-y-2">
              <h4 className="text-xs font-bold text-foreground uppercase tracking-wider">Order summary</h4>
              {cartItems.map((i) => (
                <div key={i.id} className="flex justify-between gap-3 text-sm text-cosmic-silver">
                  <span>{i.name}{i.variant ? ` (${i.variant})` : ""} × {i.quantity}</span>
                  <span>{inr(i.price * i.quantity)}</span>
                </div>
              ))}
              <div className="flex justify-between text-sm text-cosmic-silver/80 pt-2 border-t border-gold/20"><span>Subtotal</span><span>{inr(subtotal)}</span></div>
              <div className="flex justify-between text-sm text-cosmic-silver/80"><span>Shipping</span><span>{shipping > 0 ? inr(shipping) : "FREE"}</span></div>
              <div className="flex justify-between font-bold text-foreground pt-2 border-t border-gold/20"><span>Total</span><span className="text-gold">{inr(total)}</span></div>
              <p className="text-[11px] text-muted-foreground">The final amount is confirmed securely by our server before you pay.</p>
            </div>

            <Button type="submit" disabled={busy !== null} className="w-full h-12 bg-gradient-gold text-primary-foreground font-bold text-sm sm:text-base rounded-xl shadow-lg hover:opacity-95">
              {busy ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" /> {busy === "verifying" ? "Confirming your payment…" : "Starting secure payment…"}
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4" /> Pay {inr(total)} securely
                </span>
              )}
            </Button>
            <p className="text-center text-[11px] text-muted-foreground">UPI, Cards, Net Banking and Wallets via Razorpay</p>
          </form>
        </motion.div>
      </div>
    </PageLayout>
  );
};

export default Checkout;
