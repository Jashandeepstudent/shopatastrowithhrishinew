# Changes: payments, receipt, WhatsApp, admin

Site: Astro with Hrishi. This file lists what changed, how to run and deploy it, and what is still open.
Go-live steps are in the go-live guide supplied separately (not part of this repository). The client's test list is in [CLIENT-TEST-CHECKLIST.md](CLIENT-TEST-CHECKLIST.md).

## 1. What the client asked for

| # | Requirement | Status |
|---|---|---|
| R1 | Razorpay payments work; clear Payment Successful / Payment Failed | Done. Tested with real Razorpay test payments (card success, card failure, cancel, mobile UPI) in a browser, and with automated tests. The first small live payment is checked after go-live. |
| R2 | Customers can download their receipt | Done: PDF, no GST, from the success page and from order tracking (paid orders). |
| R3 | Share payment details and receipt to the owner's WhatsApp (+91 95585 65655) | Done. The main button, on phone and computer, always opens WhatsApp to the owner's number with the details filled in and downloads the receipt PDF to attach. A small separate link offers the phone's share sheet for the file. The customer always taps send. |
| R4 | Admin panel and order tracking checked and fixed | Done and tested in a browser against the real Firebase project (admin sign-in, orders, tracking, uploads), plus automated tests. |
| R5 | Live on the client's Netlify | Ready. The update goes into the Netlify project that serves the shop; the go-live guide has the steps. |
| R6 | Code in the client's GitHub | Done: this repository holds the updated code in one commit. |

## 2. What was wrong and what was done

| ID | Problem found | What was done |
|---|---|---|
| P0-1 | No backend on Netlify; every `/api` call failed | The needed routes now run as one Netlify Function (`netlify/functions/api.mts`), reached through the same `/api/...` paths. The old Express server file (`server.ts`) is removed from the repository. |
| P0-2 | The checkout turned any payment error into PAID and invented orders in the browser | Checkout rewritten. It shows Paid only after the server confirms with Razorpay. Errors show Payment Failed or Cancelled with Retry. A network problem while confirming sends the customer to a page that asks the server and keeps checking; it never guesses. |
| P0-3 | Admin takeover (open password reset, unsigned tokens accepted, master passwords) | All master passwords and the open reset are removed. Admin is a real Firebase account; the server checks the signed token and the `admin` claim (or `ADMIN_UIDS`). Password reset is Firebase's emailed link. |
| P0-4 | Customer password takeover | Closed by not porting `/api/customer/forgot-password` and `/reset-password` (client decision). They return 404. |
| P0-5 | Price tampering (₹10 test mode, browser prices, FIRST3FREE) | The server prices every order from the catalog and ignores browser prices and `test_mode` / `is_test`. Unknown, inactive or test products, and unknown coupons, are rejected. `FIRST3FREE` and the ₹10 option are removed (and refused even if a copy exists in the database). |
| P0-6 | Razorpay secrets stored in a publicly readable database document | Secrets are read from Netlify environment variables only. The admin panel shows them as Configured/Missing and cannot store them. The new rules make `settings` unreadable to the public. The old document must be cleaned (the go-live guide). |
| P1-1 | Admin showed no orders and could not update | Admin lists and updates orders through the API (signed-in admin only). |
| P1-2 | Paid orders stuck as pending | Only the server writes payment status, through one forward-only state machine. |
| P1-3 | Firebase admin credentials never loaded; orders in memory | Credentials load from `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY`, with a clear error if missing. All orders are stored in Firestore. |
| P1-4 | Webhook rolled status back, ignored refunds | Webhook checks the signature on the raw body, ignores duplicates, only moves status forward (a late "failed" never undoes "paid"), records refunds. |
| P1-5 | order-status marked unpaid orders as paid | It only marks an order paid after the same Razorpay checks as the payment confirmation (same order, INR, exact amount, captured). |
| P1-6 | Committed `payment_settings.json` overrode the key | File removed; keys come only from environment variables. |
| P1-7 | Backend source and source map published | Source maps off, and the old Express server file (`server.ts`) is removed from the repository; `dist` holds only the website; checked. |
| P2-1 | Tracking found nothing; leaked personal data | Tracking needs order number plus the phone or email used at checkout. It returns only what the page needs (masked phone, no email or street address). Wrong details and unknown orders give the same answer. |
| P2-2 | Success page overwritten with empty data, trusted `?paid=` in the URL | The result page reads everything from the server and ignores the URL. It survives a refresh. |
| P2-3 | Status names differed; revenue counted unpaid orders | One status list for server and admin. Revenue counts paid orders only. |
| P2-4 | Signed-in users could create paid orders in the database | New Firestore rules: browsers cannot create or change orders at all. |
| P2-5 | Mobile UPI link to a personal UPI ID | Removed. All payments go through Razorpay, which also opens UPI apps on phones. |
| P2-6 | Admin upload accepted any file (stored XSS) | Images only (JPG, PNG, WebP), checked by extension, declared type and file contents, up to 4 MB, stored in Netlify Blobs and served with safe headers. |

## 3. How a payment works now

1. Customer fills the form and taps Pay. The browser sends only product ids, quantities, and delivery details.
2. `POST /api/payments/create-order` prices the cart on the server, creates the Razorpay order, stores the order as `created`, returns the order id and the public key id.
3. Razorpay Checkout opens (UPI apps, cards, net banking, wallets).
4. On success the browser sends the three Razorpay values to `POST /api/payments/verify-payment`. The server checks the signature, asks Razorpay for the payment, checks order, currency, amount and captured status, then marks the order paid (once).
5. The customer lands on `/order-success?order=<id>`, which loads from `GET /api/payments/order-status`. Failed, cancelled and still-verifying states are handled; the page keeps checking for about a minute.
6. Razorpay's webhook (`POST /api/payments/webhook`) is a backup and also records refunds.

Shipping is ₹79 under ₹999, free above. There is no GST on the receipt. There is no coupon box on checkout.

## 4. Environment variables

The go-live guide has the full table and says where each value comes from (Step 3). In short:

- Secret, server only: `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `FIREBASE_PRIVATE_KEY`.
- Server config: `RAZORPAY_KEY_ID`, `FIREBASE_CLIENT_EMAIL`, `VITE_FIREBASE_PROJECT_ID` (= `astro-with-hrishi`), optional `ADMIN_UIDS`.
- New names: `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `ADMIN_UIDS`.
- No longer used: `FIREBASE_SERVICE_ACCOUNT`, `FIREBASE_SERVICE_ACCOUNT_KEY`, `STORE_UPI_ID`, `VITE_RAZORPAY_KEY_ID`, `VITE_BACKEND_URL`.
- `.env` is git-ignored; `.env.example` lists names only.

## 5. Webhook

- URL path: `/api/payments/webhook` (same as the old code; nothing in Razorpay was created or changed).
- Events handled: `payment.captured`, `order.paid`, `payment.failed`, `refund.processed`.
- Signature: `X-Razorpay-Signature` against the raw body with `RAZORPAY_WEBHOOK_SECRET`.
- The client should compare their Razorpay webhook settings with this (go-live guide, Step 6).

## 6. Admin setup

- Sign in at `/admin/login` with email and password.
- Create the first admin with `node --env-file=.env.admin scripts/create-admin.mjs <email>` (set up once by the developer; run again for another admin email). It prints a one-time password.
- Forgotten password: "Forgot password?" on the sign-in page sends Firebase's reset link. Change Password inside Admin does the same.
- Admin can change fulfilment fields (status, courier, tracking number and link, delivery date, notes). It can never change payment status, cannot ship or confirm an unpaid order, and cannot delete orders.

## 7. Firestore rules (deployed to astro-with-hrishi on 18 Oct)

Rules are in [firestore.rules](firestore.rules). Summary: only the server writes orders and payment events; customers read only their own orders; settings and coupons are not public; admin means the `admin` claim (the old email-based admin is gone); tested in the emulator (12 rule tests).

## 8. Tests

| Suite | Count | What it covers |
|---|---|---|
| Backend (emulators, Razorpay mocked) | 39 | price tampering, test products, FIRST3FREE, signatures, fake payment ids, wrong amount/order, failures, webhook duplicates/late/refund, tracking, admin permissions, upload rejection |
| Firestore rules (emulators) | 12 | forged orders, other people's orders, settings and coupons, claim-only admin |
| Frontend | 18 | checkout success/failure/cancel/network cases, result page, receipt PDF, WhatsApp share |
| Browser run (Edge, emulators) | 34 checks | admin sign-in, wrong password, non-admin refused, orders, tracking, receipt download, refresh, fake `?paid=true`, upload |

Run: `npm run emulators` in one terminal (needs Java 21), then `npm run test:functions` and `npx vitest run`.
Local site with the API: `npm run dev:netlify` (http://localhost:8888).

## 9. Open items and things not fixed (outside the agreed scope)

- The Razorpay webhook is a backup only and was not exercised end to end here; the code and its tests cover signature checks, duplicates, late failures and refunds. After go-live the owner compares the existing webhook with the address and events in the go-live guide.
- Live payments only work from the website address registered in Razorpay. Customers on any other address see: "Payments are not enabled for this website address yet. Please contact us on WhatsApp."
- The first small live payment is checked after go-live (go-live guide, Step 7).
- Customer accounts were not touched (out of scope). Noted: the customer login stores the password in the browser's local storage (`awh_saved_accounts`); recommend a separate fix.
- No rate limiting on order tracking or admin sign-in beyond Firebase's own sign-in limits.
- Admin video upload is not available (functions have a 6 MB request limit); paste video links instead. Product images are limited to 4 MB.
- The Admin tabs for products, reviews and highlights still read and write some content directly in Firestore with the admin claim. Rules allow this only for admins.
- Product reviews can be created by any signed-in customer (unchanged).
- Receipt shows the logo and address supplied by the owner.
- First request after a quiet period can be slow (function cold start).
- Public `/assets/*` files are cached for a year even when not content-hashed (unchanged, existing setting): replacing a logo file may need a new filename.
- The sitemap now lists the real catalog only; the old ₹1 test page is gone.
- Google Tag Manager is not wired (the admin field exists but nothing loads it).

## 10. Files

- Backend: `netlify/functions/api.mts`, `netlify/lib/` (Firebase, Razorpay, pricing, orders, auth, routes), `netlify/tests/`.
- Frontend: `src/pages/Checkout.tsx`, `src/pages/OrderSuccess.tsx`, `src/lib/paymentApi.ts`, `src/lib/receipt.ts`, `src/pages/AdminLogin.tsx`, `src/hooks/useAuth.tsx`, `src/lib/adminApi.ts`, tracking and admin components.
- Config: `netlify.toml`, `firestore.rules`, `firebase.json`, `.env.example`.
- Scripts: `scripts/create-admin.mjs`.
