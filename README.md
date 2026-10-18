# Astro With Hrishi

The website and online shop for Astro With Hrishi: astrology products, appointment booking, online payment with Razorpay, a PDF receipt, order tracking and an admin panel.

- **Website:** React, TypeScript and Vite.
- **Server:** Netlify Functions. All `/api/*` addresses go to one function (`netlify/functions/api.mts`).
- **Database and sign-in:** Firebase (Firestore and Authentication). The database rules are in `firestore.rules`.
- **Payments:** Razorpay. Prices are worked out on the server, and every payment is checked with Razorpay before an order is marked paid.
- **Images uploaded in the admin panel:** Netlify Blobs.

What changed and how it was tested: see [CHANGES.md](CHANGES.md). A test list for the owner: [CLIENT-TEST-CHECKLIST.md](CLIENT-TEST-CHECKLIST.md).

## Settings (environment variables)

Set these in Netlify (Project configuration, Environment variables). Names only; never put values in the code or in this repository.

Server (secret):

- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `ADMIN_UIDS` (optional; comma-separated sign-in IDs that may use the admin panel, in addition to accounts marked as admin)

Website (public values, no secrets):

- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_APP_ID`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_SITE_URL`
- `VITE_GA_MEASUREMENT_ID`
- `VITE_GOOGLE_ADS_ID`
- `VITE_GOOGLE_ADS_CONVERSION_LABEL`
- `VITE_META_PIXEL_ID`
- `VITE_GTM_ID`
- `VITE_GOOGLE_SITE_VERIFICATION`

`.env.example` lists the same names for local use.

## Netlify build settings

These are already in `netlify.toml`; the boxes in Netlify can stay empty.

| Setting | Value |
|---|---|
| Build command | `npm run build` |
| Publish directory | `dist` |
| Functions directory | `netlify/functions` |
| Node version | 22 |

The payment webhook address is `/api/payments/webhook` (for example `https://your-domain/api/payments/webhook`). It handles `payment.captured`, `order.paid`, `payment.failed` and `refund.processed`.

## Run it on your computer

You need Node 22 and npm.

```
npm ci
cp .env.example .env     # then fill in Razorpay TEST keys and the Firebase values
npm run dev              # the website only, http://localhost:3000
npm run dev:netlify      # the website and the server together, http://localhost:8888
```

Use Razorpay **test** keys on your computer. Live keys belong only in Netlify.

To work without a real database, start the local Firebase emulators in a second window (needs Java 11 or newer): `npm run emulators`, and set `VITE_USE_FIREBASE_EMULATOR=true` and `VITE_FIREBASE_PROJECT_ID=demo-astro-hrishi`.

## Checks

```
npm run typecheck:functions     # type check of the server code
npx tsc -p tsconfig.app.json --noEmit   # type check of the website
npm test                        # website tests
npm run test:functions          # server and database-rule tests (emulators must be running)
npm run build                   # production build into dist/
```

## Admin panel

Admin sign-in uses Firebase accounts only. To create or promote an admin account (needs the Firebase values and the two server credentials in the environment):

```
node --env-file=.env.admin scripts/create-admin.mjs owner@example.com
```

Database rules are published with `node --env-file=.env.admin scripts/deploy-rules.mjs` (change the live database rules only on purpose).
