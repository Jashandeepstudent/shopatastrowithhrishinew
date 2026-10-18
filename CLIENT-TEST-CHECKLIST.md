# Test checklist for the website owner

Please test on the preview link you were sent. This preview uses **test payments**: no real money moves.
Tick each box. If something does not work, write down what you did, what you expected, and what you saw (a screenshot helps), and send it to your developer.

Test it on: [ ] an Android phone  [ ] an iPhone  [ ] a computer

## A. Paying

Use these test details when the payment window asks:
- Card (use this one; other test cards are rejected as international): `5267 3181 8797 5449`, any future date, any 3-digit CVV.
- If the card asks for an OTP, choose **Pay on bank's page**, then tap **Success** (or **Failure** to test a failed payment).
- UPI: on a phone, pick Google Pay (or another UPI app) in the payment window. In test mode it completes by itself.
- If a test bank page appears, tap **Success** (or **Failure** to test a failed payment).

1. [ ] Add a product to the cart, go to checkout, fill in your details, and tap **Pay**. The payment window opens.
2. [ ] Pay with the test **card**. You see **Payment Successful** with the order ID, payment ID, amount, date and time.
3. [ ] On a phone, repeat with **UPI** (Google Pay). You see **Payment Successful**.
4. [ ] Repeat with the test card and tap **Failure** on the bank page. You see **Payment Failed** with a reason and a **Retry** button.
5. [ ] Tap **Retry** and pay successfully. It works.
6. [ ] Open the payment window and close it without paying. You see **Payment cancelled** and a **Retry** button. No order is marked paid.
7. [ ] On the success page, refresh the page. The same details are still shown.
8. [ ] There is no ₹10 "test" option, no discount code box, and no button that sends money to a personal UPI ID.
9. [ ] On a phone, the payment window offers your UPI apps (Google Pay, PhonePe and so on).

## B. Receipt

10. [ ] On the success page, tap **Download Receipt**. A PDF is saved.
11. [ ] Open the PDF. It shows: Astro with Hrishi and the logo, receipt number, date and time, your name, phone and email, the items, the amount in rupees, payment ID, order ID, payment method, and status **Paid**. There is **no GST**.
12. [ ] Tell your developer whether the logo and address on the receipt are the ones you want.

## C. WhatsApp

13. [ ] On the success page, tap **Send to Owner on WhatsApp** (on a phone and on a computer).
    - WhatsApp opens to **+91 95585 65655** with the payment details already typed in, and the receipt PDF downloads at the same time. You see the hint "Receipt downloaded. Attach it in WhatsApp and tap send."
    - In WhatsApp, attach the downloaded receipt (paperclip, Document) and tap send.
14. [ ] The message that reaches the owner's WhatsApp shows the customer name, order ID, payment ID, amount, date and "Paid".
15. [ ] Below the button there is a small link, "Share receipt file with another app". It opens the phone's own share sheet (this one lets you pick any app). The main button never does that; it always goes to the owner's number.

(WhatsApp never sends by itself; the customer always has to tap send.)

## C2. Page behaviour (phone)

- [ ] Open a product page, scroll to the bottom, go back to the shop and open a product again: the product page opens at the **top** every time. The same for the cart.
- [ ] Tap the browser's back button: you return to where you were on the previous page.
- (Not changed, as on the old site: the Astro with Hrishi logo intro plays each time you open the home page.)

## D. Tracking an order

16. [ ] Open **Track Order**. Enter the order number from the success page and the **phone number** you used. You see the order status and delivery progress.
17. [ ] Try the right order number with a **wrong phone number**. It says the details are invalid and shows nothing about the order.
18. [ ] For a paid order, a **Download receipt** button is shown and works.

## E. Admin panel

Your developer will give you the admin email and a one-time password.

19. [ ] Go to `/admin/login`. Sign in with the email and password. You reach the Admin Dashboard.
20. [ ] A wrong password does not sign you in. The old shared password no longer works.
21. [ ] Open **Order tracking** (Orders tab). You see your test orders with the right status (Paid for the successful ones, not paid for failed or cancelled ones).
22. [ ] Open a paid order and change its status (for example to Confirmed, then Shipped). Add a courier name and tracking number. Then check **Track Order** as a customer: the new status and tracking show.
23. [ ] Open an order that was **not paid** and try to mark it Shipped. It is refused.
24. [ ] On the dashboard, **Shop Revenue** only counts paid orders.
25. [ ] In **Payment Gateway**, you see the mode (Test now, Live later) and that the keys are "Configured". You cannot see or edit the secret keys here.
26. [ ] In **Shop**, upload a product picture (JPG, PNG or WebP, up to 4 MB). It shows on the product. Trying to upload another kind of file (for example a web page) is refused.
27. [ ] Click **Change Password**. An email with a reset link is sent.
28. [ ] Sign out. Opening `/admin` takes you back to the sign-in page.

## F. Before going live (with the real payment keys)

29. [ ] In Razorpay, Settings, Webhooks: check that the webhook URL is `https://<your site>/api/payments/webhook`, and that these events are on: `payment.captured`, `order.paid`, `payment.failed`, `refund.processed`. (Do not change anything; just tell your developer what you see.)
30. [ ] After go-live, make **one small real payment** on the live site. You see Payment Successful, the order shows as Paid in Admin, and the money appears in Razorpay. You can refund it from Razorpay.
31. [ ] After go-live, regenerate the Razorpay key secret and webhook secret in Razorpay and give the new values to your developer (they update them in Netlify).

Anything not on this list (customer sign-up, login, profile) was not part of this job and was not changed.
