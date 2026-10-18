import { ADDRESS, EMAIL, PHONE_NUMBER, WHATSAPP_NUMBER } from "@/lib/whatsapp";
import type { PaidOrder } from "@/lib/paymentApi";

/*
 * Payment receipt (simple, no GST) generated from server-verified order data only.
 * The PDF library is loaded on demand so it does not weigh down the rest of the site.
 */

export const BUSINESS_NAME = "Astro with Hrishi";
const LOGO_URL = "/assets/brand-logo-light.png";
const RECEIPT_LOGO_URL = "/receipt-logo.png";

/** "Rs." is used because the standard PDF fonts cannot draw the rupee sign. */
const rs = (n: number) => `Rs. ${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;

export const istDateTime = (iso: string | null | undefined) => {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return `${d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  })} IST`;
};

export const methodLabel = (m: string | null | undefined) => {
  const v = String(m || "").toLowerCase();
  const map: Record<string, string> = { upi: "UPI", card: "Card", netbanking: "Net Banking", wallet: "Wallet", emi: "EMI", razorpay: "Razorpay" };
  return map[v] || (v ? v.toUpperCase() : "Online (Razorpay)");
};

const loadLogo = async (): Promise<{ data: string; w: number; h: number } | null> => {
  try {
    // Prefer the dedicated receipt logo when it has been added; otherwise use the site logo.
    let res = await fetch(RECEIPT_LOGO_URL).catch(() => null);
    if (!res || !res.ok || !(res.headers.get("content-type") || "").startsWith("image/")) res = await fetch(LOGO_URL);
    if (!res.ok) return null;
    const blob = await res.blob();
    const data: string = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
    const dims: { w: number; h: number } = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = reject;
      img.src = data;
    });
    return { data, ...dims };
  } catch {
    return null;
  }
};

export const receiptFileName = (o: Pick<PaidOrder, "order_number" | "order_id">) =>
  `Receipt-${(o.order_number || o.order_id).replace(/[^A-Za-z0-9_-]/g, "")}.pdf`;

/** Builds the receipt PDF for a paid order. Throws if the order is not paid. */
export const buildReceiptPdf = async (o: PaidOrder): Promise<Blob> => {
  if (o.payment_status !== "paid" && o.payment_status !== "refunded") {
    throw new Error("A receipt is only available for paid orders.");
  }
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const W = 210;
  const M = 16;
  const gold: [number, number, number] = [138, 109, 27];
  let y = 18;

  const logo = await loadLogo();
  let logoW = 0;
  if (logo) {
    const h = 24;
    const w = Math.min(40, (logo.w / logo.h) * h);
    logoW = w;
    try {
      doc.addImage(logo.data, "PNG", M, y - 4, w, h);
    } catch {
      /* logo is optional */
    }
  }
  const textX = logo ? M + logoW + 6 : M;
  doc.setFont("helvetica", "bold").setFontSize(18).setTextColor(...gold).text(BUSINESS_NAME, textX, y + 3);
  doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(90);
  doc.text(doc.splitTextToSize(ADDRESS, W - textX - M), textX, y + 9);
  doc.text(`${PHONE_NUMBER}  |  ${EMAIL}`, textX, y + 19);

  y = 44;
  doc.setDrawColor(...gold).setLineWidth(0.6).line(M, y, W - M, y);
  y += 9;
  doc.setFont("helvetica", "bold").setFontSize(14).setTextColor(30).text("PAYMENT RECEIPT", M, y);
  doc.setFillColor(232, 247, 238).roundedRect(W - M - 30, y - 6, 30, 8, 2, 2, "F");
  doc.setFontSize(9).setTextColor(18, 112, 58).text(o.payment_status === "refunded" ? "REFUNDED" : "PAID", W - M - 15, y - 0.8, { align: "center" });

  y += 9;
  const meta: [string, string][] = [
    ["Receipt No.", o.order_number || o.order_id],
    ["Date & time", istDateTime(o.paid_at || o.created_at)],
    ["Order ID", o.order_number || o.order_id],
    ["Payment ID", o.payment_id || "-"],
    ["Payment method", methodLabel(o.payment_method)],
    ["Status", o.payment_status === "refunded" ? "Refunded" : "Paid"],
  ];
  doc.setFontSize(9.5);
  meta.forEach(([k, v], i) => {
    const col = i % 2;
    const rowY = y + Math.floor(i / 2) * 7;
    const x = M + col * 92;
    doc.setFont("helvetica", "normal").setTextColor(110).text(k, x, rowY);
    doc.setFont("helvetica", "bold").setTextColor(30).text(doc.splitTextToSize(String(v), 58)[0], x + 30, rowY);
  });
  y += 3 * 7 + 4;

  doc.setFont("helvetica", "bold").setFontSize(9).setTextColor(...gold).text("BILLED TO", M, y);
  y += 5;
  doc.setFont("helvetica", "bold").setFontSize(10).setTextColor(30).text(o.customer_name, M, y);
  y += 5;
  doc.setFont("helvetica", "normal").setFontSize(9.5).setTextColor(70);
  doc.text(`Phone: ${o.customer_phone}`, M, y);
  if (o.customer_email) {
    y += 5;
    doc.text(`Email: ${o.customer_email}`, M, y);
  }
  y += 9;

  // Items table
  doc.setFillColor(250, 245, 230).rect(M, y - 5, W - 2 * M, 8, "F");
  doc.setFont("helvetica", "bold").setFontSize(8.5).setTextColor(...gold);
  doc.text("ITEM", M + 2, y);
  doc.text("QTY", 128, y, { align: "right" });
  doc.text("PRICE", 158, y, { align: "right" });
  doc.text("AMOUNT", W - M - 2, y, { align: "right" });
  y += 7;
  doc.setFont("helvetica", "normal").setFontSize(9.5).setTextColor(30);
  for (const it of o.items) {
    const name = `${it.name}${it.variant ? ` (${it.variant})` : ""}`;
    const lines: string[] = doc.splitTextToSize(name, 92);
    doc.text(lines, M + 2, y);
    doc.text(String(it.quantity), 128, y, { align: "right" });
    doc.text(rs(it.price), 158, y, { align: "right" });
    doc.text(rs(it.price * it.quantity), W - M - 2, y, { align: "right" });
    y += 5.2 * lines.length + 2;
    doc.setDrawColor(235).setLineWidth(0.2).line(M, y - 3, W - M, y - 3);
    if (y > 250) {
      doc.addPage();
      y = 20;
    }
  }

  y += 3;
  const totalRow = (label: string, value: string, bold = false) => {
    doc.setFont("helvetica", bold ? "bold" : "normal").setFontSize(bold ? 11.5 : 9.5).setTextColor(bold ? 30 : 80);
    doc.text(label, 130, y);
    doc.text(value, W - M - 2, y, { align: "right" });
    y += bold ? 7 : 5.5;
  };
  totalRow("Subtotal", rs(o.subtotal));
  if (o.discount > 0) totalRow("Discount", `- ${rs(o.discount)}`);
  totalRow("Shipping", o.shipping > 0 ? rs(o.shipping) : "FREE");
  doc.setDrawColor(...gold).setLineWidth(0.5).line(128, y - 3, W - M, y - 3);
  y += 1;
  totalRow("Total paid (INR)", rs(o.total), true);

  doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(120);
  doc.text("Thank you for your order.", W / 2, 278, { align: "center" });
  doc.text("This is a computer-generated receipt and does not require a signature.", W / 2, 283, { align: "center" });

  return doc.output("blob");
};

const saveBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
};

export const downloadReceipt = async (o: PaidOrder) => {
  saveBlob(await buildReceiptPdf(o), receiptFileName(o));
};

/* ─── WhatsApp share (R3) ─── */

/** Plain-text payment details sent to the owner. */
export const whatsappMessage = (o: PaidOrder) =>
  [
    "Hello Astro with Hrishi, I have completed my payment.",
    "",
    `Name: ${o.customer_name}`,
    `Order ID: ${o.order_number || o.order_id}`,
    `Payment ID: ${o.payment_id || "-"}`,
    `Amount: ${rs(o.total)}`,
    `Date: ${istDateTime(o.paid_at || o.created_at)}`,
    "Status: Paid",
  ].join("\n");

export const whatsappLink = (o: PaidOrder) => `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(whatsappMessage(o))}`;

/**
 * MAIN BUTTON. Always opens the owner's WhatsApp (+91 95585 65655) with the payment details typed in,
 * and downloads the receipt PDF so the customer can attach it. WhatsApp never sends by itself:
 * the customer attaches the file and taps send.
 */
export const sendReceiptToOwnerOnWhatsApp = async (o: PaidOrder, prebuilt?: Blob): Promise<void> => {
  // Browsers only allow opening a tab straight after a tap, so open it now and point it at WhatsApp below.
  const tab = window.open("about:blank", "_blank");
  try {
    const blob = prebuilt ?? (await buildReceiptPdf(o));
    saveBlob(blob, receiptFileName(o));
    const link = whatsappLink(o);
    if (tab) tab.location.href = link;
    else window.location.assign(link);
  } catch (err) {
    tab?.close();
    throw err;
  }
};

export type ShareResult = "shared" | "cancelled" | "unsupported";

/**
 * SECONDARY, clearly separate option: the phone's share sheet with the receipt file, so it can go to any app.
 * It is not used for the owner button.
 */
export const shareReceiptFile = async (o: PaidOrder, prebuilt?: Blob): Promise<ShareResult> => {
  const blob = prebuilt ?? (await buildReceiptPdf(o));
  const file = new File([blob], receiptFileName(o), { type: "application/pdf" });
  if (typeof navigator.canShare !== "function" || !navigator.canShare({ files: [file] })) return "unsupported";
  try {
    await navigator.share({ files: [file], title: `${BUSINESS_NAME} receipt` });
    return "shared";
  } catch (err: any) {
    if (err?.name === "AbortError") return "cancelled";
    return "unsupported";
  }
};
