import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

const api = vi.hoisted(() => ({
  createPaymentOrder: vi.fn(),
  verifyPaymentOnServer: vi.fn(),
  fetchOrderStatus: vi.fn(),
  checkAttempt: vi.fn(),
}));

vi.mock("@/lib/paymentApi", async () => {
  const actual = await vi.importActual<typeof import("@/lib/paymentApi")>("@/lib/paymentApi");
  return { ...actual, ...api };
});
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ firebaseUser: null, user: null }) }));
vi.mock("@/components/PageLayout", () => ({ default: ({ children }: any) => <div>{children}</div> }));
vi.mock("@/components/SEO", () => ({ default: () => null }));
vi.mock("@/lib/analytics", () => ({
  trackBeginCheckout: vi.fn(),
  trackAddPaymentInfo: vi.fn(),
  trackPurchase: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }) }));

import Checkout from "@/pages/Checkout";
import OrderSuccess from "@/pages/OrderSuccess";
import { ApiError, type PaidOrder } from "@/lib/paymentApi";
import { buildReceiptPdf, sendReceiptToOwnerOnWhatsApp, shareReceiptFile, whatsappLink } from "@/lib/receipt";
import { useCart } from "@/lib/cart";

const ORDER_ID = "ord_0123456789abcdef01234567";
const created = {
  order_id: ORDER_ID,
  order_number: "AWH-2026-ABC234",
  razorpay_order_id: "order_TestOrder12345",
  key_id: "rzp_test_Example12345",
  amount: 129900,
  currency: "INR",
  total: 1299,
};

const paidOrder = (over: Partial<PaidOrder> = {}): PaidOrder => ({
  order_id: ORDER_ID,
  order_number: "AWH-2026-ABC234",
  status: "payment_confirmed",
  payment_status: "paid",
  payment_method: "upi",
  payment_id: "pay_TestPayment12345",
  failure_reason: null,
  paid_at: "2026-10-17T06:30:00.000Z",
  created_at: "2026-10-17T06:28:00.000Z",
  customer_name: "Asha Patel",
  customer_phone: "9876543210",
  customer_email: "asha@example.com",
  items: [{ id: "trishield-bracelet", name: "Trishield Bracelet", price: 1299, quantity: 1 }],
  subtotal: 1299,
  discount: 0,
  shipping: 0,
  total: 1299,
  currency: "INR",
  ...over,
});

const Where = () => <div data-testid="where">{useLocation().pathname + useLocation().search}</div>;

const renderCheckout = () =>
  render(
    <MemoryRouter initialEntries={["/checkout"]}>
      <Routes>
        <Route path="/checkout" element={<Checkout />} />
        <Route path="/order-success" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );

const fillAndPay = async () => {
  fireEvent.change(screen.getByPlaceholderText("Receiver name"), { target: { value: "Asha Patel" } });
  fireEvent.change(screen.getByPlaceholderText("9876543210"), { target: { value: "9876543210" } });
  fireEvent.change(screen.getByPlaceholderText("your.email@example.com"), { target: { value: "asha@example.com" } });
  fireEvent.change(screen.getByPlaceholderText(/Flat 402/), { target: { value: "Flat 402, MG Road" } });
  fireEvent.change(screen.getByPlaceholderText("Vadodara"), { target: { value: "Vadodara" } });
  fireEvent.change(screen.getByDisplayValue("Select State"), { target: { value: "Gujarat" } });
  fireEvent.change(screen.getByPlaceholderText("390022"), { target: { value: "390022" } });
  fireEvent.click(screen.getByRole("button", { name: /pay .* securely/i }));
};

let rzpOptions: any;
let rzpHandlers: Record<string, (r: any) => void>;
let rzpOpen: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  rzpHandlers = {};
  rzpOpen = vi.fn();
  (window as any).Razorpay = function (options: any) {
    rzpOptions = options;
    return { open: rzpOpen, on: (evt: string, fn: any) => (rzpHandlers[evt] = fn) };
  };
  useCart.setState({
    items: [{ id: "trishield-bracelet", product_id: "trishield-bracelet", name: "Trishield Bracelet", price: 1299, image_url: null, quantity: 1 }],
  });
  api.createPaymentOrder.mockResolvedValue(created);
  // by default the server finds no payment on the order
  api.checkAttempt.mockResolvedValue(paidOrder({ payment_status: "created", payment_id: null, paid_at: null }));
});

afterEach(() => cleanup());

describe("Checkout", () => {
  it("sends no prices or test flags, opens Razorpay with the server order", async () => {
    renderCheckout();
    await fillAndPay();
    await waitFor(() => expect(rzpOpen).toHaveBeenCalled());

    const body = api.createPaymentOrder.mock.calls[0][0];
    expect(JSON.stringify(body)).not.toMatch(/price|test_mode|is_test|amount|total/i);
    expect(body.items).toEqual([{ id: "trishield-bracelet", quantity: 1, variant: null }]);
    expect(rzpOptions.order_id).toBe(created.razorpay_order_id);
    expect(rzpOptions.key).toBe(created.key_id);
    expect(rzpOptions.amount).toBe(129900);
  });

  it("verifies on the server after success, then shows the result page", async () => {
    api.verifyPaymentOnServer.mockResolvedValue({ success: true, ...paidOrder() });
    renderCheckout();
    await fillAndPay();
    await waitFor(() => expect(rzpOpen).toHaveBeenCalled());

    rzpOptions.handler({ razorpay_order_id: created.razorpay_order_id, razorpay_payment_id: "pay_TestPayment12345", razorpay_signature: "abc" });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(`/order-success?order=${ORDER_ID}`));
    expect(api.verifyPaymentOnServer).toHaveBeenCalledWith(expect.objectContaining({ order_id: ORDER_ID, razorpay_signature: "abc" }));
  });

  it("never shows success when the server rejects the payment (bad signature)", async () => {
    api.verifyPaymentOnServer.mockRejectedValue(new ApiError(400, "Payment verification failed"));
    renderCheckout();
    await fillAndPay();
    await waitFor(() => expect(rzpOpen).toHaveBeenCalled());

    rzpOptions.handler({ razorpay_order_id: created.razorpay_order_id, razorpay_payment_id: "pay_TestPayment12345", razorpay_signature: "forged" });
    await screen.findByText("Payment Failed");
    expect(screen.getByText(/Payment verification failed/)).toBeTruthy();
    expect(screen.queryByTestId("where")).toBeNull();
  });

  it("lets the result page check the server when verify fails because of the network", async () => {
    api.verifyPaymentOnServer.mockRejectedValue(new ApiError(0, "Network problem"));
    renderCheckout();
    await fillAndPay();
    await waitFor(() => expect(rzpOpen).toHaveBeenCalled());

    rzpOptions.handler({ razorpay_order_id: created.razorpay_order_id, razorpay_payment_id: "pay_TestPayment12345", razorpay_signature: "abc" });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toContain("/order-success?order="));
  });

  it("does not open payment or invent an order when create-order fails", async () => {
    api.createPaymentOrder.mockRejectedValue(new ApiError(502, "Payment gateway is unavailable. Please try again in a moment."));
    renderCheckout();
    await fillAndPay();
    await screen.findByText("We could not start the payment");
    expect(rzpOpen).not.toHaveBeenCalled();
    expect(api.verifyPaymentOnServer).not.toHaveBeenCalled();
    expect(screen.queryByTestId("where")).toBeNull();
    expect(screen.getByRole("button", { name: /retry payment/i })).toBeTruthy();
  });

  it("shows Payment Failed with the reason and Retry when Razorpay reports a failure", async () => {
    renderCheckout();
    await fillAndPay();
    await waitFor(() => expect(rzpOpen).toHaveBeenCalled());

    rzpHandlers["payment.failed"]({ error: { description: "Your card was declined by the bank" } });
    await screen.findByText("Payment Failed");
    expect(screen.getByText(/Your card was declined by the bank/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry payment/i })).toBeTruthy();
  });

  it("shows a cancelled state with Retry when the window is closed, and retry reuses the order", async () => {
    renderCheckout();
    await fillAndPay();
    await waitFor(() => expect(rzpOpen).toHaveBeenCalledTimes(1));

    rzpOptions.modal.ondismiss();
    await screen.findByText("Payment cancelled");
    fireEvent.click(screen.getByRole("button", { name: /retry payment/i }));
    await waitFor(() => expect(rzpOpen).toHaveBeenCalledTimes(2));
    expect(api.createPaymentOrder).toHaveBeenCalledTimes(1);
  });
});

describe("Checkout asks the server about the payment attempt", () => {
  const BLOCKED = "Payment blocked as website does not match registered website(s)";
  const NOT_ENABLED = "Payments are not enabled for this website address yet. Please contact us on WhatsApp.";

  it("replaces Razorpay's technical 'website does not match' error with a plain message", async () => {
    renderCheckout();
    await fillAndPay();
    await waitFor(() => expect(rzpOpen).toHaveBeenCalled());
    rzpHandlers["payment.failed"]({ error: { code: "BAD_REQUEST_ERROR", description: BLOCKED, reason: "payment_risk_check_failed" } });
    await screen.findByText("Payment Failed");
    expect(screen.getByText(NOT_ENABLED)).toBeTruthy();
    expect(screen.queryByText(/does not match registered website/i)).toBeNull();
    expect(screen.queryByText(/bank will refund/i)).toBeNull();
    expect(api.checkAttempt).toHaveBeenCalledWith(created.order_id);
  });

  it("uses the reason the server stored when it has one", async () => {
    api.checkAttempt.mockResolvedValue(paidOrder({ payment_status: "failed", failure_reason: BLOCKED, payment_id: null, paid_at: null }));
    renderCheckout();
    await fillAndPay();
    await waitFor(() => expect(rzpOpen).toHaveBeenCalled());
    rzpHandlers["payment.failed"]({ error: {} });
    await screen.findByText(NOT_ENABLED);
  });

  it("other failure reasons are still shown as they are", async () => {
    renderCheckout();
    await fillAndPay();
    await waitFor(() => expect(rzpOpen).toHaveBeenCalled());
    rzpHandlers["payment.failed"]({ error: { description: "Insufficient funds in the account" } });
    await screen.findByText(/Insufficient funds in the account/);
  });

  it("a failed-payment report goes to the success page when the server finds the payment captured", async () => {
    api.checkAttempt.mockResolvedValue(paidOrder());
    renderCheckout();
    await fillAndPay();
    await waitFor(() => expect(rzpOpen).toHaveBeenCalled());
    rzpHandlers["payment.failed"]({ error: { description: "Network error" } });
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(`/order-success?order=${ORDER_ID}`));
    expect(screen.queryByText("Payment Failed")).toBeNull();
  });

  it("closing the window goes to the success page when the server finds the payment captured", async () => {
    api.checkAttempt.mockResolvedValue(paidOrder());
    renderCheckout();
    await fillAndPay();
    await waitFor(() => expect(rzpOpen).toHaveBeenCalled());
    rzpOptions.modal.ondismiss();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(`/order-success?order=${ORDER_ID}`));
    expect(screen.queryByText("Payment cancelled")).toBeNull();
  });

  it("closing the window shows cancelled after asking the server once", async () => {
    renderCheckout();
    await fillAndPay();
    await waitFor(() => expect(rzpOpen).toHaveBeenCalled());
    rzpOptions.modal.ondismiss();
    await screen.findByText("Payment cancelled");
    expect(api.checkAttempt).toHaveBeenCalledTimes(1);
  });

  it("still shows cancelled / failed when the server cannot be reached (never blocks the customer)", async () => {
    api.checkAttempt.mockRejectedValue(new ApiError(0, "Network problem"));
    renderCheckout();
    await fillAndPay();
    await waitFor(() => expect(rzpOpen).toHaveBeenCalled());
    rzpOptions.modal.ondismiss();
    await screen.findByText("Payment cancelled");
  });
});

describe("Payment result page", () => {
  const renderResult = (id = ORDER_ID) =>
    render(
      <MemoryRouter initialEntries={[`/order-success?order=${id}`]}>
        <Routes>
          <Route path="/order-success" element={<OrderSuccess />} />
        </Routes>
      </MemoryRouter>
    );

  it("shows Payment Successful with the server data, receipt and WhatsApp buttons", async () => {
    api.fetchOrderStatus.mockResolvedValue(paidOrder());
    renderResult();
    await screen.findByText("Payment Successful");
    expect(screen.getByText("AWH-2026-ABC234")).toBeTruthy();
    expect(screen.getByText("pay_TestPayment12345")).toBeTruthy();
    expect(screen.getAllByText("₹1,299").length).toBeGreaterThan(0);
    expect(screen.getByText(/17 Oct 2026/)).toBeTruthy();
    expect(screen.getByText(/IST/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /download receipt/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /send to owner on whatsapp/i })).toBeTruthy();
    expect(api.fetchOrderStatus).toHaveBeenCalledWith(ORDER_ID);
  });

  it("shows Card (not UPI) as the payment method for a card payment", async () => {
    api.fetchOrderStatus.mockResolvedValue(paidOrder({ payment_method: "card" }));
    renderResult();
    await screen.findByText("Payment Successful");
    expect(screen.getByText("Card")).toBeTruthy();
    expect(screen.queryByText("UPI")).toBeNull();
  });

  it("shows UPI for a UPI payment", async () => {
    api.fetchOrderStatus.mockResolvedValue(paidOrder({ payment_method: "upi" }));
    renderResult();
    await screen.findByText("Payment Successful");
    expect(screen.getByText("UPI")).toBeTruthy();
    expect(screen.queryByText("Card")).toBeNull();
  });

  it("shows Payment Failed with Retry for a failed order", async () => {
    api.fetchOrderStatus.mockResolvedValue(paidOrder({ payment_status: "failed", failure_reason: "Insufficient funds", payment_id: null }));
    renderResult();
    await screen.findByText("Payment Failed");
    expect(screen.getByText(/Insufficient funds/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry payment/i })).toBeTruthy();
    expect(screen.queryByText("Payment Successful")).toBeNull();
  });

  it("shows Verifying (never success) while the order is still unpaid", async () => {
    api.fetchOrderStatus.mockResolvedValue(paidOrder({ payment_status: "created", payment_id: null, paid_at: null }));
    renderResult();
    await screen.findByText("Verifying your payment…");
    expect(screen.queryByText("Payment Successful")).toBeNull();
    expect(screen.queryByRole("button", { name: /download receipt/i })).toBeNull();
  });

  it("does not trust a paid flag in the URL", async () => {
    api.fetchOrderStatus.mockResolvedValue(paidOrder({ payment_status: "created", payment_id: null, paid_at: null }));
    render(
      <MemoryRouter initialEntries={[`/order-success?order=${ORDER_ID}&paid=true&status=PAID&razorpay_payment_status=paid`]}>
        <Routes>
          <Route path="/order-success" element={<OrderSuccess />} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByText("Verifying your payment…");
    expect(screen.queryByText("Payment Successful")).toBeNull();
  });

  it("failed result page shows the plain message instead of Razorpay's technical error", async () => {
    api.fetchOrderStatus.mockResolvedValue(paidOrder({ payment_status: "failed", failure_reason: "Payment blocked as website does not match registered website(s)", payment_id: null, paid_at: null }));
    renderResult();
    await screen.findByText("Payment Failed");
    expect(screen.getByText("Payments are not enabled for this website address yet. Please contact us on WhatsApp.")).toBeTruthy();
    expect(screen.queryByText(/does not match registered website/i)).toBeNull();
  });

  it("rejects an invalid order link without calling the server", async () => {
    renderResult("AWH-2026-ABC234");
    await screen.findByText("We could not find this order");
    expect(api.fetchOrderStatus).not.toHaveBeenCalled();
  });
});

describe("Receipt and WhatsApp share", () => {
  it("builds a PDF with the required fields and no GST", async () => {
    const blob = await buildReceiptPdf(paidOrder());
    const text = await new Promise<string>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsText(blob);
    });
    expect(text.startsWith("%PDF")).toBe(true);
    for (const needle of ["Astro with Hrishi", "AWH-2026-ABC234", "pay_TestPayment12345", "Asha Patel", "9876543210", "asha@example.com", "Trishield Bracelet", "Rs. 1,299", "UPI", "17 Oct 2026", "IST"]) {
      expect(text).toContain(needle);
    }
    expect(text).not.toMatch(/GST/i);
  });

  it("prints Card (not UPI) on the receipt of a card payment", async () => {
    const blob = await buildReceiptPdf(paidOrder({ payment_method: "card" }));
    const text = await new Promise<string>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.readAsText(blob);
    });
    expect(text).toContain("Payment method");
    expect(text).toContain("Card");
    expect(text).not.toContain("UPI");
  });

  it("refuses to build a receipt for an unpaid order", async () => {
    await expect(buildReceiptPdf(paidOrder({ payment_status: "created" }))).rejects.toThrow(/only available for paid/i);
  });

  it("builds the WhatsApp link for +91 95585 65655 with the payment details", () => {
    const link = whatsappLink(paidOrder());
    expect(link.startsWith("https://wa.me/919558565655?text=")).toBe(true);
    const msg = decodeURIComponent(link.split("text=")[1]);
    for (const needle of ["Asha Patel", "AWH-2026-ABC234", "pay_TestPayment12345", "Rs. 1,299", "17 Oct 2026", "Paid"]) {
      expect(msg).toContain(needle);
    }
  });

  it("main WhatsApp button goes to the owner, never to the share sheet, and downloads the receipt", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    // even a device that supports file sharing must not get the system share sheet from the main button
    Object.assign(navigator, { canShare: () => true, share });
    (URL as any).createObjectURL = vi.fn(() => "blob:x");
    (URL as any).revokeObjectURL = vi.fn();
    const clicks: string[] = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { clicks.push(this.download); };
    const tab = { location: { href: "" }, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(tab as any);
    await sendReceiptToOwnerOnWhatsApp(paidOrder());
    HTMLAnchorElement.prototype.click = orig;
    expect(share).not.toHaveBeenCalled();
    expect(open.mock.calls[0][0]).toBe("about:blank"); // opened on the tap itself
    expect(tab.location.href.startsWith("https://wa.me/919558565655?text=")).toBe(true);
    expect(clicks).toContain("Receipt-AWH-2026-ABC234.pdf");
  });

  it("the separate share option uses the share sheet only when files can be shared", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { canShare: () => true, share });
    expect(await shareReceiptFile(paidOrder())).toBe("shared");
    expect(share.mock.calls[0][0].files[0].type).toBe("application/pdf");
    Object.assign(navigator, { canShare: undefined, share: undefined });
    expect(await shareReceiptFile(paidOrder())).toBe("unsupported");
  });
});
