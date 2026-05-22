# SiamEPOS Spa — User Manual

A complete guide for spa owners and staff. No technical knowledge required.

---

## Table of contents

1. [Getting started](#1-getting-started)
2. [Front desk — daily operations](#2-front-desk--daily-operations)
3. [Checkout & payments](#3-checkout--payments)
4. [Online bookings (your website)](#4-online-bookings-your-website)
5. [Customer self-service portal](#5-customer-self-service-portal)
6. [Phone bookings + payment links](#6-phone-bookings--payment-links)
7. [Treatwell integration](#7-treatwell-integration)
8. [Staff management](#8-staff-management)
9. [Treatments, rooms, categories](#9-treatments-rooms-categories)
10. [Clients (CRM) & medical questionnaire](#10-clients-crm--medical-questionnaire)
11. [Gift vouchers](#11-gift-vouchers)
12. [Email campaigns](#12-email-campaigns)
13. [Reports & end-of-day](#13-reports--end-of-day)
14. [Settings](#14-settings)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. Getting started

### Logging in
1. Open `https://spa.siamepos.co.uk` (or your branded URL) on a tablet, laptop, or phone.
2. Tap your PIN. The default admin PIN on a fresh install is **1234** — change it immediately (see [Staff management](#8-staff-management)).
3. You're now in the spa system.

### First-day setup checklist
Before your first booking, complete these in **Admin**:

- [ ] **🔧 Settings** — fill in your spa name, address, phone, email. These appear on receipts, emails, and the Z-Report.
- [ ] **👥 Therapists** — add each staff member with a unique PIN, role (admin / manager / reception / therapist), and optional photo + specialisms.
- [ ] **📅 Rota** — set each therapist's normal weekly schedule.
- [ ] **🛁 Rooms** — add your treatment rooms (e.g. "Room A", "Couples Suite").
- [ ] **💆 Treatments** — add each treatment with duration, price, and category. Set the VAT rate if applicable.
- [ ] **⚙️ Booking** — set opening hours, slot interval, and tip suggestions.
- [ ] **🌐 Online Booking** — set the deposit policy if you'll accept online bookings.

After this, the system is ready to take bookings.

---

## 2. Front desk — daily operations

The main screen is the **Appointment timeline** — vertical columns, one per therapist working today, time running top to bottom.

### Quick visual key on the timeline

| What you see | Meaning |
|---|---|
| Column header with **★ 10:00–20:00** in gold | Therapist has a custom-hour override today (special shift) |
| Column header with **11:00–21:00** in white | Therapist's normal weekly rota |
| **"Off"** label | Therapist isn't working today |
| Grey diagonal-striped bands top/bottom of column | Hours outside their working window — bookings blocked here |
| Coloured block on the column | A booking (colour = appointment status or payment method) |

### Booking colours

| Colour | Meaning |
|---|---|
| 🔵 Blue | **Booked** — confirmed appointment, not yet started |
| 🟢 Green | **In progress** — customer has arrived and started |
| ⬜ Grey | **Completed** — service finished, awaiting checkout |
| 🟠 Orange | Completed + paid by **Cash** |
| 🩷 Pink | Completed + paid by **Card** |
| 🟢 Green | Completed + paid by **Voucher** |
| 🟡 Yellow | Completed + paid by **Treatwell** |
| 🟣 Violet | Completed + paid by **Split** |

### Making a new booking

**Method 1 — Click an empty slot**
1. On the timeline, tap any empty time on the therapist's column.
2. The booking modal opens with date, time, and therapist pre-filled.
3. Pick the treatment.
4. Find the customer:
   - Type in the search box → existing clients appear → tap the right one.
   - Or expand **"+ New client / walk-in (full details)"** to create a new client. Fill in name (required) + phone, email, date of birth, emergency contact, GP, GDPR consent, marketing opt-in, notes.
5. Tap **Book appointment**.

**Method 2 — Use the +New button**
Tap the **+ New** button in the action bar. Pick treatment first, then date/time, then customer, then save.

### Editing or rescheduling
Double-click any booking on the timeline to open the Edit modal. Change the treatment, time, therapist, status, or notes. Save changes.

### Status changes (without checkout)
On the Edit modal, change the **Status** dropdown:
- **Booked** → **In progress** when the customer arrives and you take them to the room
- **In progress** → **Completed** when they finish (then go to checkout)
- **Cancelled** if they cancel before arrival
- **No-show** if they don't turn up

### Cancellations and refunds
- **Walk-in bookings**: change status to "Cancelled" — done.
- **Online bookings with a paid deposit**: the customer can self-cancel via their email link (refund if inside the window, forfeit if outside). Or you can refund manually from **Admin → 🌐 Online Booking** (see section 4).

---

## 3. Checkout & payments

When a customer's appointment is in **In progress** or **Completed** status, tap their booking on the timeline → tap **Checkout** (or **Bill**).

### Checkout screen layout

```
┌──────────────────────────────────────┐
│ Treatment               £55.00        │
│ Tip                      £0.00        │
│ Total                   £55.00        │
│                                       │
│ 💳 Deposit paid online   −£25.00     │  ← only if booked online with deposit
│ ┌──────────────────────────────────┐ │
│ │ Balance due now    £30.00         │ │  ← what the customer owes now
│ └──────────────────────────────────┘ │
│                                       │
│ [Tip: 10% 12.5% 15% No tip Custom]   │
│                                       │
│ Payment method:                       │
│ [Cash] [Card] [🎁 Voucher] [🌐 Treatwell] [⇄ Split] │
└──────────────────────────────────────┘
```

### Single-method payments
- **Cash**: tap Cash — bill closes. If there was a deposit, the system records it as "deposit £25 + cash £30" automatically.
- **Card**: tap Card — bill closes. If you have a card reader, take payment there separately.
- **🎁 Voucher**: tap Voucher → enter the voucher code → Check → confirm Redeem.
- **🌐 Treatwell**: tap Treatwell (the customer paid Treatwell directly; this just closes the bill on your side).

### Split payments (mixed methods)
Tap **⇄ Split**. The Split modal opens with a sticky header showing the total and remaining balance.

1. Two rows are pre-filled (Cash and Card).
2. For each row: pick the method (Cash / Card / 🎁 Voucher) and type the amount.
3. **🎁 Voucher** row expands with a code-lookup field — enter the code, tap Check.
4. The header shows **"Remaining £X"** in white or **"Over by £X"** in red until you balance to exactly the bill total.
5. When balanced, the **"Take £X & close bill"** button turns gold.
6. Tap it — the bill closes with the per-method breakdown stored. Each portion shows in reports under its own payment method (no money lost in a generic "split" bucket).

### Tips
Before picking the payment method, set the tip:
- Tap one of the percentage buttons (10% / 12.5% / 15%) for a quick suggested amount based on the treatment price.
- Or tap **No tip** or type a **Custom** £ amount.
- Tips are recorded separately in reports.

---

## 4. Online bookings (your website)

The spa has a public booking widget that customers can use from your website.

### Embedding the widget
Go to **Admin → 🔗 Embed Codes** to find the embed snippets:

**Option 1 — Drop-in button (recommended):**
```html
<script src="https://spa-api.siamepos.co.uk/booking-widget.js" defer></script>
<div id="siamespa-booking"></div>
```
Paste this where you want a "Book your treatment" button to appear.

**Option 2 — Your own button:**
```html
<script src="https://spa-api.siamepos.co.uk/widget.js" defer></script>
<button onclick="SiamEPOSSpa.open()">Book now</button>
```

### What the customer sees
1. **Treatment** — picks from your live list
2. **Therapist** — sees photos + specialisms (or "Any available")
3. **Date + time** — slot picker, filtered by chosen therapist's availability
4. **Details** — name, phone, email, GDPR consent
5. **Payment** — Stripe card input (if deposit policy is set)
6. **Confirmation** — booking reference + manage-link

### Deposit policy
Go to **Admin → 🌐 Online Booking** to set:

- **Deposit model**:
  - **No deposit** — customers book online without paying.
  - **Fixed amount** — same £ deposit on every booking (e.g. £25). Most common.
  - **Percentage** — % of treatment price (e.g. 25%). Higher-value treatments get higher deposits.
  - **Full prepay** — customer pays the whole treatment online; nothing due at the spa.

- **Cancel window (hours)** — how many hours before the appointment customers can cancel for free.
- **Cancellation policy text** — shown to customers on the booking portal.

### Live online bookings view
The **🌐 Online Booking** tab also shows a live list of every online booking with:
- Date, client, treatment, therapist
- Payment status pill (Deposit paid / Refunded / Forfeit / Fully paid)
- Stripe deep-link
- Refund button

### How deposit cash flow works
- Deposit lands in **your Stripe account** when the customer pays online.
- It shows in the trading report under **🌐 Online deposits** — separately from till cash.
- When the customer arrives and pays the balance at the till, the deposit is automatically credited on the bill (you only collect the balance).
- At end-of-day, the Z-Report shows both: till cash + Stripe deposits.

---

## 5. Customer self-service portal

Every confirmed online booking gets a "Manage your booking" link in the confirmation email. The page works without login (via a secure token in the URL).

### What customers can do
- **See their booking** — date, time, treatment, therapist, deposit paid, balance due
- **Reschedule** — pick a new slot from your live availability. The system revalidates the rota server-side.
- **Cancel** — refund inside the policy window, forfeit outside. Either way they get a cancellation email.

### What customers cannot do
- Change the treatment (would re-open the price question).
- Reschedule into a slot that doesn't fit your therapist's rota.
- Edit other people's bookings (the token is signed and tied to one appointment).

---

## 6. Phone bookings + payment links

Sometimes a customer rings up and wants to book a specific therapist + treatment + time, and wants to pay immediately without going to your website.

**Flow:**
1. Receptionist creates the booking in admin (as a normal booking).
2. On the Edit modal, you'll see **"💳 Deposit not collected"** with a gold **Request deposit by link** button.
3. Tap it → backend generates a Stripe payment link.
4. The panel expands with three buttons:
   - **📋 Copy** — copies the link to clipboard
   - **📱 WhatsApp** — opens WhatsApp with the link pre-typed in a message
   - **✉️ Email** — opens your mail app with the link in a prefilled message to the customer
5. Send the link via whichever channel suits the customer.
6. The booking is now in **deposit_pending** state — held but unconfirmed.
7. Customer taps the link → opens a pay page → enters card → pays.
8. The booking automatically flips to **deposit_paid** and confirmation email goes out.

If the customer loses the link, just tap **🔄 New link** to mint a fresh one.

---

## 7. Treatwell integration

If your spa is listed on Treatwell, bookings flow in automatically via webhook.

### Setup (one-off)
1. Set `TREATWELL_WEBHOOK_SECRET` env var on Railway (any long random string).
2. In the Treatwell partner portal, add the webhook URL:
   `https://spa-api.siamepos.co.uk/api/treatwell/webhook`
3. Set the `X-Treatwell-Secret` header to the same secret value.

### What happens
- A Treatwell booking arrives → the system creates the appointment + client, tagged `source='treatwell'`.
- It maps the treatment by name (case-insensitive). If no match, the booking is flagged with `[unmatched treatment]` in the notes for your manual review.
- Cancellations via Treatwell flip the appointment status to "Cancelled".
- Duplicate webhooks are ignored.

### Closing a Treatwell bill
At checkout, you'll see a **🌐 Treatwell** button (always visible, but only relevant when the customer came via Treatwell). Tap it — the bill closes without taking cash. Treatwell settles to your bank account separately, minus their commission.

### Treatwell in reports
- **Admin → 👤 Clients** has a 🌐 Treatwell pill so you can spot Treatwell customers and target them with direct-booking offers (lower fees).
- **Admin → 📈 Reports** has a "Booking source" card showing Treatwell vs direct revenue.

---

## 8. Staff management

### Adding a therapist
**Admin → 👥 Therapists → + New**
- **Name** *
- **PIN** (4–6 digits, unique)
- **Role**: admin / manager / reception / therapist
- **Specialisms** — comma-separated, shown on the booking widget (e.g. "Deep tissue, Hot stone")
- **Photo URL** — square headshot, shown on the widget + demo site
- **Active** — uncheck to retire a therapist without deleting them

### PINs and roles
- **Admin / Manager** — full access including refunds, voids, deleting bills.
- **Reception** — bookings + checkout. No admin tab.
- **Therapist** — usually clock in/out only.

Each role has its own permissions; design your team accordingly.

### Setting the weekly rota
**Admin → 📅 Rota → Weekly Rota tab**
- Pick a therapist
- Add windows per day-of-week (e.g. Mon 09:00–18:00, Tue off, Wed 12:00–20:00)

### Date-specific overrides (custom hours)
**Admin → 📅 Rota → Override Calendar tab**
- Tap any future date on the calendar grid
- Mark the therapist as working or off for that specific date, with custom hours if working

**Rule:** date-specific overrides always win over the weekly rota. The timeline shows override hours with a **gold star ★** prefix.

### When are bookings blocked?
- Outside any rota or override hours → "rota_conflict" — system suggests alternative times or therapists.
- During an existing appointment → time conflict — system suggests gaps in the day.

---

## 9. Treatments, rooms, categories

### Treatments
**Admin → 💆 Treatments**
- **Name** *
- **Category** (organise menus on the widget)
- **Duration** in minutes (drives the slot picker)
- **Price** in £
- **VAT rate** (default 20)
- **Description** (shown on the widget)
- **Active** — uncheck to hide without deleting

### Rooms
**Admin → 🛁 Rooms** — name and capacity. The booking engine picks a free room for each appointment automatically.

### Categories
Group treatments by category for the menu on your website widget. Create + edit them in the Treatments admin section.

---

## 10. Clients (CRM) & medical questionnaire

### The client list
**Admin → 👤 Clients**

For each client you'll see:
- **Status pill**: VIP (10+ visits) · Regular (3–9) · New (1–2) · Lapsed (no visit in 60+ days)
- **Source pill**: 🌐 Treatwell · 🪷 Widget · 🚶 Walk-in · 🧑‍💼 Staff
- **Total visits**, **lifetime spend**, **last visit date**
- **Marketing consent** toggle (click to flip)
- **Online deposit** badge on bookings paid online

### Filters and export
- Filter by status, source, or text search
- Tap **Export CSV** to download a spreadsheet (respects whatever filters are applied)

### Editing a client
Tap a row → **Client Profile** opens with tabs:
- **Details** — name, phone, email, DOB, emergency contact, GP, notes
- **Medical** — full questionnaire (pregnancy, conditions, allergies, medications, GDPR consent, digital signature)
- **History** — every past appointment with status, payment method, and 🌐 Online deposit badge where relevant

### Medical questionnaire (UK legal requirement)
For each client receiving a treatment, you must record:
- Pregnancy / heart conditions / diabetes / epilepsy / cancer / DVT / recent surgery / fractures / skin conditions / varicose veins / osteoporosis / lymphoedema (Yes/No each)
- Blood pressure (none / low / normal / high)
- Medications · Allergies · Areas to avoid · Skin conditions detail
- **Digital signature** (typed name)
- GDPR consent must be ticked before saving

### GDPR — right to erasure
**Admin** users can permanently delete a client via the trash button (visible after a 5-tap gesture on the client name). This is **permanent** — no soft delete. Used for GDPR erasure requests.

---

## 11. Gift vouchers

Spas often sell vouchers as gifts (e.g. Christmas) or as treatment bundles (e.g. "10 Thai Massages — £450").

### Selling a voucher
**Admin → 🎁 Vouchers → Sell**

**Voucher type:**
- **💷 Money** — typical gift voucher. Customer can spend the £ balance against any treatment. Optionally set expiry date.
- **🎟 Sessions** — bundle of treatments. Set the treatment (or "Any treatment") and the number of sessions. Customer pays once for the bundle, then redeems one session per visit.

**Required fields:**
- Voucher value (sale price)
- For sessions: number of sessions
- Buyer's name (Purchased by)
- Recipient's name (Gift for)
- **Recipient email** (optional) — if set, we email the voucher to them automatically with a branded gift-style template
- **Expiry date** (optional)
- **How did the customer pay?** — Cash / Card / Split (mandatory)

After save, the voucher code (`SPA-XXXXXXXX`) appears on screen. Hand it to the customer or note that we emailed it.

### Redeeming a voucher at checkout
**At checkout:**
- Tap the **🎁 Voucher** button
- Enter the code → Check
- Confirm Redeem

For **money vouchers**: spends min(balance, bill total). If voucher doesn't cover the full bill, you'll need to take the remainder via Cash/Card (use Split for this).

For **session vouchers**: consumes one session. Voucher must be valid for that treatment (or "Any treatment"). One voucher = one bill = one session.

### Voucher in split payments
You can redeem part of a voucher's value as one row in a split payment (e.g. £40 voucher + £25 card). Pick **🎁 Voucher** in a row, enter the code, the row expands with the balance shown. The system caps the amount at the voucher's remaining value.

---

## 12. Email campaigns

Send branded broadcast emails to segments of your client list.

### Segments
- **VIP** — 10+ visits
- **Regular** — 3–9 visits
- **Lapsed** — no visit in 60+ days
- **Treatwell** — clients who came via Treatwell
- **All marketing-consented** — everyone who opted in

Only clients with **marketing_consent = TRUE** and **unsubscribed_at IS NULL** receive emails. GDPR-compliant by design.

### Sending a campaign
**Admin → 📧 Campaigns**

1. Pick the segment (preview shows the recipient count)
2. Subject + HTML body (use `{{name}}` to personalise)
3. **Preview** to see the rendered email
4. **Send** — Brevo sends one email per recipient, sequentially

Each email carries an unsubscribe link in the footer — required by UK law. Clicking it stamps `unsubscribed_at` on that client (permanent — even if `marketing_consent` flips back to TRUE later, the unsubscribe wins).

### Campaign history
The same screen shows previously sent campaigns with date, segment, recipient count.

---

## 13. Reports & end-of-day

### Trading report
**Admin → 📊 Trading**

Today's snapshot:
- **Revenue / Tips / Bills paid** — money taken via bills today
- **Appointments / No-shows / Cancelled** — booking counts
- **By payment method** — cash / card / voucher / deposit / treatwell with bill counts and £
- **By source** — Treatwell vs direct booking revenue
- **🌐 Online deposits** — Stripe-side money in (separate from bill revenue to avoid double-counting)
- **🎁 Voucher sales** — vouchers sold today (deferred revenue)
- **Top treatments** — bookings + revenue per treatment

### Z-Report (end-of-day)
**Admin → 🔐 Z Report**

The till close report for accounting:
- Your spa name + address + phone at the top (printed/exported)
- Subtotal · Tips · Total · Bill count
- By payment method (with deposit row labelled "🌐 deposit (online)")
- 🎁 Voucher sales section
- 🌐 Online deposits — Stripe-side movement (taken / refunded / pending / consumed / forfeit)
- **Bills detail table** — line-by-line list of every bill closed today
- **📥 Export CSV** — downloads `z-report_YYYY-MM-DD.csv` with line-by-line + per-method columns + summary
- **🖨 Print** — opens print preview with the spa identity, summary, and bills detail formatted for an A4 sheet or save-as-PDF
- **Close Z report** — stamps the day as closed (audit trail)

### Therapist report
**Admin → 📈 Reports → Therapist breakdown**
For any date range:
- Bills · Revenue · Tips · Total — per therapist

Useful for commission calculations.

### CSV exports across the system
Most reports have a **📥 Export CSV** button. Always respects whatever filter / date range you're viewing. Filenames include the relevant context so downloads don't overwrite (e.g. `bills_2026-05-22_to_2026-05-22_Cash.csv`).

---

## 14. Settings

**Admin → 🔧 Settings**

### Spa identity
- **Spa name** — shows on receipts, emails, Z-Report header
- **Address** — Z-Report header
- **Phone** — Z-Report header
- **Email** — Z-Report header, customer-facing communications

### Other settings (scattered across tabs)
- **⚙️ Booking** — opening hours, slot interval (15 min default), advance booking window, tip suggestions, VAT rate
- **🌐 Online Booking** — deposit policy + cancellation policy (see [section 4](#4-online-bookings-your-website))

---

## 15. Troubleshooting

### "Can't scroll on mobile"
Hard-refresh: **⌘ + Shift + R** on Mac, **Ctrl + Shift + R** on Windows. We use mobile-aware viewport units; the browser sometimes caches old layouts.

### "Voucher button doesn't show in split payment"
You're seeing a cached old version. Hard-refresh (see above). The current split modal supports **Cash / Card / 🎁 Voucher** as the three row methods.

### "Override hours don't apply to timeline"
Hard-refresh. Then check the timeline column header — if you see a **gold star ★** prefix with the override hours, it's working. If you only see plain white text with the rota hours, the override isn't being matched (rare — contact support).

### "Customer paid online but checkout still asks for full price"
Open the appointment from the timeline and verify the green **"💳 Deposit £25 paid online · balance due at till"** banner is shown. If not, the deposit was never recorded — check **Admin → 🌐 Online Booking** for the booking's payment status.

### "Booking widget on my website shows 'Stripe not configured'"
Set these env vars on your Railway service:
- `STRIPE_PUBLISHABLE_KEY` — pk_live_… or pk_test_…
- `STRIPE_SECRET_KEY` — sk_live_… or sk_test_…
- `STRIPE_WEBHOOK_SECRET` — from Stripe dashboard webhook
- `BOOKING_SECRET` — generate with `openssl rand -hex 32`

Then in Stripe → Webhooks, point `https://spa-api.siamepos.co.uk/api/stripe/webhook` to the event `payment_intent.succeeded`.

Without these, the widget books without a deposit (gracefully degraded). Once they're set, deposit collection lights up automatically.

### "Customer says they didn't get the confirmation email"
- Check `BREVO_API_KEY` is set on Railway.
- Check the client's email on **Admin → 👤 Clients** — typos happen.
- Resend by editing the booking and saving again (triggers a fresh send) — or generate a new payment link if it was a phone booking.

### "I want to backdate a booking"
The admin booking form accepts any date. For historical entry, use the +New button rather than the timeline (timeline only shows today by default — navigate the date picker first).

### "GDPR — customer asks to be deleted"
**Admin → 👤 Clients → tap their row → tap their name 5 times** → 🗑 trash button appears → confirm. This is **permanent**. All their bookings, medical records, and contact details are wiped from the database. Past bills retain their financial record but are anonymised.

### "Z-Report shows wrong shop name"
Set it via **Admin → 🔧 Settings → Spa name** (settings table value wins over env var fallback). Hard-refresh.

### "Need help"
- Email support: info@siamepos.co.uk
- Owner: Korakot Kongponsrisiri

---

## Quick reference — daily checklist

**Open of day**
- [ ] Check today's bookings on the timeline
- [ ] Confirm no rota gaps in any therapist column
- [ ] Skim Admin → 🌐 Online Booking for new online bookings overnight

**Throughout the day**
- [ ] Update booking status as customers arrive (Booked → In Progress → Completed)
- [ ] Checkout customers as they finish — tap payment method, take cash/card

**End of day**
- [ ] Admin → 🔐 Z Report → check totals match the till
- [ ] Tap **📥 Export CSV** for the accountant
- [ ] Tap **🖨 Print** if you want a paper record
- [ ] Tap **Close Z report**

---

*SiamEPOS Spa · info@siamepos.co.uk · Built for Thai spa businesses in the UK*
