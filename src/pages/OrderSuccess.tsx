import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { motion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Clock, Download, Loader2, MessageCircle, RefreshCw, RotateCcw, ShoppingBag, Truck } from "lucide-react";
import { toast } from "sonner";
import PageLayout from "@/components/PageLayout";
import SEO from "@/components/SEO";
import { Button } from "@/components/ui/button";
import { inr } from "@/lib/shop";
import { useCart } from "@/lib/cart";
import { trackPurchase } from "@/lib/analytics";
import { waLink } from "@/lib/whatsapp";
import { ApiError, NOT_ENABLED_MESSAGE, fetchOrderStatus, friendlyFailure, type PaidOrder } from "@/lib/paymentApi";
import { buildReceiptPdf, istDateTime, methodLabel, receiptFileName, sendReceiptToOwnerOnWhatsApp, shareReceiptFile } from "@/lib/receipt";

const ORDER_ID_RE = /^ord_[a-f0-9]{24}$/;
const POLL_MS = 3000;
const POLL_LIMIT = 20; // about one minute of automatic checking

type View =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "error"; message: string }
  | { kind: "order"; order: PaidOrder };

/** Payment result page. Everything shown comes from the server, never from the URL. */
const OrderSuccess = () => {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const orderId = params.get("order") || "";
  const { clear } = useCart();

  const [view, setView] = useState<View>({ kind: "loading" });
  const [polls, setPolls] = useState(0);
  const [working, setWorking] = useState<null | "download" | "share">(null);
  const trackedRef = useRef(false);
  // The receipt is prepared as soon as the payment is confirmed so a tap responds instantly.
  const pdfRef = useRef<Blob | null>(null);

  const load = useCallback(async () => {
    try {
      const order = await fetchOrderStatus(orderId);
      setView({ kind: "order", order });
      return order;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setView({ kind: "invalid" });
      else setView((v) => (v.kind === "order" ? v : { kind: "error", message: (err as Error).message }));
      return null;
    }
  }, [orderId]);

  // Initial load, then keep checking while the payment is still being confirmed.
  useEffect(() => {
    if (!ORDER_ID_RE.test(orderId)) {
      setView({ kind: "invalid" });
      return;
    }
    let cancelled = false;
    let count = 0;
    const tick = async () => {
      const order = await load();
      if (cancelled) return;
      count += 1;
      setPolls(count);
      const waiting = !order || order.payment_status === "created";
      if (waiting && count < POLL_LIMIT) timer = setTimeout(tick, POLL_MS);
    };
    let timer: ReturnType<typeof setTimeout> = setTimeout(tick, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [orderId, load]);

  const order = view.kind === "order" ? view.order : null;
  const paid = order?.payment_status === "paid";

  useEffect(() => {
    if (!order || !paid || trackedRef.current) return;
    trackedRef.current = true;
    clear();
    try {
      sessionStorage.removeItem("awh_pending_order");
    } catch {
      /* ignore */
    }
    // Only a payment confirmed in the last 2 hours counts: reopening an old receipt link never re-reports it.
    const paidAt = order.paid_at ? new Date(order.paid_at).getTime() : 0;
    if (Date.now() - paidAt < 2 * 60 * 60 * 1000)
    trackPurchase({
      orderId: order.order_id,
      orderNumber: order.order_number ?? order.order_id,
      total: order.total,
      shipping: order.shipping,
      currency: "INR",
      items: order.items.map((i) => ({ id: i.id ?? i.name, name: i.name, price: i.price, quantity: i.quantity, variant: i.variant ?? null })),
    });
  }, [order, paid, clear]);

  useEffect(() => {
    if (!order || !paid) return;
    pdfRef.current = null;
    buildReceiptPdf(order).then((b) => (pdfRef.current = b)).catch(() => undefined);
  }, [order, paid]);

  const stillWaiting = !order || order.payment_status === "created";
  const gaveUp = stillWaiting && polls >= POLL_LIMIT;

  const onDownload = async () => {
    if (!order) return;
    setWorking("download");
    try {
      const blob = pdfRef.current ?? (await buildReceiptPdf(order));
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = receiptFileName(order);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (err: any) {
      toast.error(err?.message || "Could not create the receipt. Please try again.");
    } finally {
      setWorking(null);
    }
  };

  const onShare = async () => {
    if (!order) return;
    setWorking("share");
    try {
      await sendReceiptToOwnerOnWhatsApp(order, pdfRef.current ?? undefined);
      toast.success("Receipt downloaded. Attach it in WhatsApp and tap send.", { duration: 10000 });
    } catch (err: any) {
      toast.error(err?.message || "Could not prepare the receipt. Please try again.");
    } finally {
      setWorking(null);
    }
  };

  const onShareFile = async () => {
    if (!order) return;
    try {
      const r = await shareReceiptFile(order, pdfRef.current ?? undefined);
      if (r === "unsupported") toast.info("This device cannot share files. Use Download Receipt instead.");
    } catch (err: any) {
      toast.error(err?.message || "Could not prepare the receipt. Please try again.");
    }
  };

  const Row = ({ k, v, mono }: { k: string; v: string; mono?: boolean }) => (
    <div className="flex justify-between gap-4 text-sm py-1.5">
      <span className="text-cosmic-silver/60">{k}</span>
      <span className={`text-right text-cosmic-silver break-all ${mono ? "font-mono text-xs" : ""}`}>{v}</span>
    </div>
  );

  return (
    <PageLayout title="Payment">
      <SEO title="Payment Status — Astro With Hrishi" description="Your payment status" path="/order-success" noindex />
      <div className="container max-w-xl pt-24 pb-24 px-4">
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="glass-gold rounded-3xl border border-gold/30 p-6 sm:p-8 shadow-xl">
          {view.kind === "invalid" && (
            <div className="text-center space-y-3">
              <AlertTriangle className="h-10 w-10 text-amber-400 mx-auto" />
              <h1 className="text-xl font-serif text-cosmic-silver">We could not find this order</h1>
              <p className="text-sm text-cosmic-silver/70">Please open the link from your payment confirmation, or track your order with your order number and phone.</p>
              <Button asChild className="bg-gradient-gold text-primary-foreground rounded-xl"><Link to="/track-order">Track my order</Link></Button>
            </div>
          )}

          {view.kind === "error" && !order && (
            <div className="text-center space-y-3">
              <AlertTriangle className="h-10 w-10 text-amber-400 mx-auto" />
              <h1 className="text-xl font-serif text-cosmic-silver">Could not check your payment</h1>
              <p className="text-sm text-cosmic-silver/70">{view.message}</p>
              <Button onClick={() => void load()} className="bg-gradient-gold text-primary-foreground rounded-xl"><RefreshCw className="h-4 w-4 mr-2" /> Check again</Button>
            </div>
          )}

          {view.kind === "loading" && (
            <div className="text-center py-8 space-y-3">
              <Loader2 className="h-9 w-9 text-gold animate-spin mx-auto" />
              <p className="text-cosmic-silver/80">Checking your payment…</p>
            </div>
          )}

          {order && stillWaiting && (
            <div className="text-center space-y-3">
              {gaveUp ? <Clock className="h-10 w-10 text-amber-400 mx-auto" /> : <Loader2 className="h-10 w-10 text-gold animate-spin mx-auto" />}
              <h1 className="text-xl font-serif text-cosmic-silver">{gaveUp ? "Payment not confirmed yet" : "Verifying your payment…"}</h1>
              <p className="text-sm text-cosmic-silver/70">
                {gaveUp
                  ? "We have not received a confirmation from the bank yet. If money was deducted, it will be confirmed shortly or refunded automatically. Please do not pay again."
                  : "Please wait a moment. Do not close this page or pay again."}
              </p>
              <div className="rounded-xl border border-gold/20 p-3 text-left">
                <Row k="Order ID" v={order.order_number || order.order_id} />
                <Row k="Amount" v={inr(order.total)} />
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => { setPolls(0); void load(); }} variant="outline" className="border-gold/30 text-cosmic-silver rounded-xl"><RefreshCw className="h-4 w-4 mr-2" /> Check again</Button>
                <Button asChild variant="outline" className="border-gold/30 text-cosmic-silver rounded-xl">
                  <a href={waLink(`Hello, I paid for order ${order.order_number || order.order_id} but it is not confirmed yet.`)} target="_blank" rel="noreferrer"><MessageCircle className="h-4 w-4 mr-2" /> Need help?</a>
                </Button>
              </div>
            </div>
          )}

          {order && order.payment_status === "failed" && (
            <div className="text-center space-y-3">
              <AlertTriangle className="h-12 w-12 text-red-400 mx-auto" />
              <h1 className="text-2xl font-serif text-cosmic-silver">Payment Failed</h1>
              <p className="text-sm text-cosmic-silver/70">{friendlyFailure(order.failure_reason) === NOT_ENABLED_MESSAGE ? NOT_ENABLED_MESSAGE : `${order.failure_reason || "Your payment could not be completed."} If money was deducted, your bank will refund it.`}</p>
              <div className="rounded-xl border border-gold/20 p-3 text-left">
                <Row k="Order ID" v={order.order_number || order.order_id} />
                <Row k="Amount" v={inr(order.total)} />
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => nav("/checkout")} className="bg-gradient-gold text-primary-foreground rounded-xl"><RotateCcw className="h-4 w-4 mr-2" /> Retry Payment</Button>
                <Button asChild variant="outline" className="border-gold/30 text-cosmic-silver rounded-xl">
                  <a href={waLink(`Hello, my payment for order ${order.order_number || order.order_id} failed. Please help.`)} target="_blank" rel="noreferrer"><MessageCircle className="h-4 w-4 mr-2" /> Need help?</a>
                </Button>
              </div>
            </div>
          )}

          {order && (order.payment_status === "paid" || order.payment_status === "refunded") && (
            <div className="space-y-5">
              <div className="text-center space-y-2">
                <CheckCircle2 className="h-14 w-14 text-emerald-400 mx-auto" />
                <h1 className="text-2xl font-serif text-cosmic-silver">{order.payment_status === "refunded" ? "Payment Refunded" : "Payment Successful"}</h1>
                <p className="text-sm text-cosmic-silver/70">Thank you, {order.customer_name.split(" ")[0]}. {order.payment_status === "paid" && "Your order is confirmed."}</p>
              </div>

              <div className="rounded-xl border border-gold/20 p-3 divide-y divide-gold/10">
                <Row k="Order ID" v={order.order_number || order.order_id} />
                <Row k="Payment ID" v={order.payment_id || "-"} mono />
                <Row k="Amount paid" v={inr(order.total)} />
                <Row k="Date & time" v={istDateTime(order.paid_at || order.created_at)} />
                <Row k="Payment method" v={methodLabel(order.payment_method)} />
              </div>

              <div className="rounded-xl border border-gold/20 p-3 space-y-1.5">
                {order.items.map((i, n) => (
                  <div key={n} className="flex justify-between gap-3 text-sm text-cosmic-silver">
                    <span>{i.name}{i.variant ? ` (${i.variant})` : ""} × {i.quantity}</span>
                    <span>{inr(i.price * i.quantity)}</span>
                  </div>
                ))}
              </div>

              <div className="grid sm:grid-cols-2 gap-2">
                <Button onClick={() => void onDownload()} disabled={working !== null} className="bg-gradient-gold text-primary-foreground font-semibold rounded-xl h-11">
                  {working === "download" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />} Download Receipt
                </Button>
                <Button onClick={() => void onShare()} disabled={working !== null} className="bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-xl h-11">
                  {working === "share" ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <MessageCircle className="h-4 w-4 mr-2" />} Send to Owner on WhatsApp
                </Button>
              </div>
              <p className="text-[11px] text-center text-cosmic-silver/60">
                This opens WhatsApp to Astro with Hrishi (+91 95585 65655) with your payment details filled in, and downloads your receipt. Attach the receipt in WhatsApp and tap send.
              </p>
              <p className="text-center">
                <button type="button" onClick={() => void onShareFile()} className="text-[11px] text-cosmic-silver/50 underline underline-offset-2 hover:text-gold">
                  Share receipt file with another app
                </button>
              </p>

              <div className="flex flex-wrap justify-center gap-2 pt-1">
                <Button asChild variant="outline" className="border-gold/30 text-cosmic-silver rounded-xl">
                  <Link to={`/track-order?order=${encodeURIComponent(order.order_number || "")}`}><Truck className="h-4 w-4 mr-2" /> Track order</Link>
                </Button>
                <Button asChild variant="outline" className="border-gold/30 text-cosmic-silver rounded-xl">
                  <Link to="/shop"><ShoppingBag className="h-4 w-4 mr-2" /> Continue shopping</Link>
                </Button>
              </div>
            </div>
          )}
        </motion.div>
      </div>
    </PageLayout>
  );
};

export default OrderSuccess;
