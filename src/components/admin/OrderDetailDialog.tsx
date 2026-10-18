import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ExternalLink, Loader2, StickyNote, CheckCircle2, ShieldCheck } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { inr } from "@/lib/shop";
import { ADMIN_STATUS_OPTIONS, canTransition, normalizeStatus, paymentLabel, statusLabel } from "@/lib/orderStatus";
import { itemsFromOrder, type AdminOrderRow, type OrderItemRow, type StatusHistoryRow } from "@/lib/orders";
import { resolveImages } from "@/lib/productImages";
import { doc, getDoc } from "firebase/firestore";
import { updateAdminOrder } from "@/lib/adminApi";
import { db } from "@/lib/firebase";

type Props = {
  order: AdminOrderRow | null;
  onClose: () => void;
  onChanged: () => void;
};

type NoteRow = { id: string; note: string; created_at: string };

const fmt = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

const inputCls = "bg-background/40 border-gold/20";

const OrderDetailDialog = ({ order, onClose, onChanged }: Props) => {
  const [currentOrder, setCurrentOrder] = useState<AdminOrderRow | null>(order);
  const [items, setItems] = useState<OrderItemRow[]>([]);
  const [history, setHistory] = useState<StatusHistoryRow[]>([]);
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [newNote, setNewNote] = useState("");
  const [status, setStatus] = useState("");
  const [statusNote, setStatusNote] = useState("");
  const [reason, setReason] = useState("");
  const [ship, setShip] = useState({ courier_name: "", tracking_number: "", tracking_url: "", estimated_delivery_date: "", shipping_note: "" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!order) return;
    try {
      const snap = await getDoc(doc(db, "orders", order.id));
      if (snap.exists()) {
        const d = { id: snap.id, ...snap.data() } as AdminOrderRow;
        setCurrentOrder(d);
        setItems(itemsFromOrder(d));
        setHistory((d as any).history || []);
        setNotes((d as any).admin_notes || []);
      }
    } catch (e) {
      console.error("Error loading order detail:", e);
      setItems(itemsFromOrder(order));
    }
  }, [order]);

  useEffect(() => {
    if (!order) return;
    setCurrentOrder(order);
    setStatus(normalizeStatus(order.status));
    setStatusNote("");
    setReason(order.cancellation_reason ?? "");
    setShip({
      courier_name: order.courier_name ?? "",
      tracking_number: order.tracking_number ?? "",
      tracking_url: order.tracking_url ?? "",
      estimated_delivery_date: order.estimated_delivery_date ?? "",
      shipping_note: order.shipping_note ?? "",
    });
    load();
  }, [order, load]);

  if (!order || !currentOrder) return null;
  const current = normalizeStatus(currentOrder.status);

  const saveStatus = async () => {
    if (status === current) return toast.info("Status unchanged");
    if (!canTransition(current, status)) return toast.error("That status change is not allowed.");
    setBusy(true);
    try {
      // The server records the history entry and refuses unpaid-order shipping or payment changes.
      await updateAdminOrder(currentOrder.id, {
        status,
        note: statusNote.trim() || null,
        ...(status === "cancelled" ? { cancellation_reason: reason.trim() || null } : {}),
      });
      toast.success(`Status updated to ${statusLabel(status)}`);
      setStatusNote("");
      onChanged();
      load();
    } catch (err: any) {
      toast.error(err.message || "Failed to update status");
    } finally {
      setBusy(false);
    }
  };

  const saveShipping = async () => {
    setBusy(true);
    try {
      await updateAdminOrder(currentOrder.id, {
        courier_name: ship.courier_name.trim() || null,
        tracking_number: ship.tracking_number.trim() || null,
        tracking_url: ship.tracking_url.trim() || null,
        estimated_delivery_date: ship.estimated_delivery_date || null,
        shipping_note: ship.shipping_note.trim() || null,
      });
      toast.success("Shipping details saved");
      onChanged();
      load();
    } catch (err: any) {
      toast.error(err.message || "Failed to update shipping");
    } finally {
      setBusy(false);
    }
  };

  const addNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newNote.trim()) return;
    setBusy(true);
    try {
      const entry: NoteRow = {
        id: `${Date.now()}`,
        note: newNote.trim(),
        created_at: new Date().toISOString(),
      };
      const updatedNotes = [entry, ...notes];
      await updateAdminOrder(currentOrder.id, { admin_notes: updatedNotes });
      setNewNote("");
      toast.success("Internal note added");
      load();
    } catch (err: any) {
      toast.error(err.message || "Failed to add note");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!order} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto glass-gold">
        <DialogHeader>
          <DialogTitle className="font-display text-gold flex items-center justify-between">
            <span>Order {currentOrder.order_number ?? currentOrder.id}</span>
            <span className="text-xs uppercase px-2 py-0.5 rounded-full border border-gold/40 text-gold">
              {statusLabel(currentOrder.status)}
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5 text-xs text-cosmic-silver/90">
          <div className="grid sm:grid-cols-2 gap-4 glass-gold rounded-xl p-4">
            <div>
              <p className="text-[10px] uppercase text-gold/80 tracking-wider">Customer Details</p>
              <p className="font-semibold text-sm mt-1">{currentOrder.customer_name}</p>
              <p className="text-muted-foreground">{currentOrder.customer_email ?? "No email provided"}</p>
              <p className="text-muted-foreground">{currentOrder.customer_phone}</p>
              <p className="mt-2 text-muted-foreground whitespace-pre-wrap">{currentOrder.address}</p>
              <p className="text-muted-foreground">{[currentOrder.city, currentOrder.state, currentOrder.pincode].filter(Boolean).join(", ")}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-gold/80 tracking-wider">Payment & Timing</p>
              <p className="mt-1">Placed: {fmt(currentOrder.created_at)}</p>
              <p>Payment: <span className="font-semibold">{paymentLabel(currentOrder.payment_status)}</span> via {currentOrder.payment_method ?? "Razorpay"}</p>
              {currentOrder.payment_id && <p className="text-muted-foreground">Payment ID: {currentOrder.payment_id}</p>}
              {currentOrder.razorpay_order_id && <p className="text-muted-foreground">RZP Order: {currentOrder.razorpay_order_id}</p>}
              <div className="mt-3 pt-3 border-t border-gold/20 font-semibold text-sm flex justify-between">
                <span>Total Amount:</span>
                <span className="text-gold">{inr(Number(currentOrder.total || 0))}</span>
              </div>
            </div>
          </div>

          <div>
            <p className="text-[10px] uppercase text-gold/80 tracking-wider mb-2">Purchased Items</p>
            <div className="glass-gold rounded-xl divide-y divide-gold/10 overflow-hidden">
              {items.map((i, idx) => (
                <div key={idx} className="p-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <img
                      src={resolveImages({ image_url: i.product_image } as any)[0]}
                      alt={i.product_name}
                      className="h-10 w-10 rounded object-cover border border-gold/20"
                    />
                    <div>
                      <p className="font-semibold text-xs">{i.product_name}</p>
                      {i.variant && <p className="text-[11px] text-muted-foreground">{i.variant}</p>}
                    </div>
                  </div>
                  <div className="text-right">
                    <p>{inr(i.price)} × {i.quantity}</p>
                    <p className="font-semibold text-gold">{inr(i.price * i.quantity)}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <div className="glass-gold rounded-xl p-4 space-y-3">
              <p className="text-[10px] uppercase text-gold/80 tracking-wider font-semibold">Update Order Status</p>
              <select value={status} onChange={(e) => setStatus(e.target.value)} className={`w-full h-9 px-2 rounded-md ${inputCls}`}>
                {ADMIN_STATUS_OPTIONS.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
              </select>
              {status === "cancelled" && (
                <Input placeholder="Cancellation reason (shown to customer)" value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} />
              )}
              <Input placeholder="Status transition note (optional)" value={statusNote} onChange={(e) => setStatusNote(e.target.value)} className={inputCls} />
              <Button onClick={saveStatus} disabled={busy || status === current} size="sm" className="w-full bg-gradient-gold text-primary-foreground">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save Status"}
              </Button>
            </div>

            <div className="glass-gold rounded-xl p-4 space-y-2">
              <p className="text-[10px] uppercase text-gold/80 tracking-wider font-semibold">Shipping & Tracking Details</p>
              <Input placeholder="Courier Name (e.g., BlueDart, Delhivery)" value={ship.courier_name} onChange={(e) => setShip({ ...ship, courier_name: e.target.value })} className={`h-8 ${inputCls}`} />
              <Input placeholder="Tracking / AWB Number" value={ship.tracking_number} onChange={(e) => setShip({ ...ship, tracking_number: e.target.value })} className={`h-8 ${inputCls}`} />
              <Input placeholder="Live Tracking URL (https://...)" value={ship.tracking_url} onChange={(e) => setShip({ ...ship, tracking_url: e.target.value })} className={`h-8 ${inputCls}`} />
              <Input type="date" placeholder="Expected Delivery Date" value={ship.estimated_delivery_date} onChange={(e) => setShip({ ...ship, estimated_delivery_date: e.target.value })} className={`h-8 ${inputCls}`} />
              <Button onClick={saveShipping} disabled={busy} size="sm" className="w-full bg-gradient-gold text-primary-foreground mt-2">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save Shipping Info"}
              </Button>
            </div>
          </div>

          <div className="glass-gold rounded-xl p-4 space-y-3">
            <p className="text-[10px] uppercase text-gold/80 tracking-wider font-semibold flex items-center gap-1">
              <StickyNote className="h-3.5 w-3.5 text-gold" /> Internal Staff Notes
            </p>
            <form onSubmit={addNote} className="flex gap-2">
              <Input placeholder="Add private note about this order..." value={newNote} onChange={(e) => setNewNote(e.target.value)} className={inputCls} />
              <Button type="submit" size="sm" disabled={busy || !newNote.trim()} className="bg-gradient-gold text-primary-foreground">Add</Button>
            </form>
            <div className="space-y-2 max-h-36 overflow-y-auto">
              {notes.map((n) => (
                <div key={n.id} className="p-2 rounded bg-background/30 text-xs border border-gold/10">
                  <p>{n.note}</p>
                  <p className="text-[10px] text-muted-foreground mt-1">{fmt(n.created_at)}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default OrderDetailDialog;
