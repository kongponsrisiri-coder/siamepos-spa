# WhatsApp AI Concierge — Setup Runbook (SPA-WHATSAPP-AI-001)

How to take the WhatsApp booking concierge from "built" to "live on a real
number." Written for a beginner — follow top to bottom. The code is already
deployed-ready; this is all **accounts + config**, no coding.

> **The big picture:** a customer messages your spa's WhatsApp number → **Twilio**
> receives it and POSTs it to our backend (`/api/whatsapp/inbound`) → **Claude**
> answers, checks real availability, holds a slot and sends a **Stripe** payment
> link → paying confirms the booking. You need a **Twilio** account and a
> **Meta (Facebook) Business** account connected to it.

---

## ⏱️ Do these in this order — the slow one first

| Order | Task | How long |
|------|------|----------|
| 1 | **Test the whole bot NOW on the Twilio Sandbox** (no approval needed) | 15 min |
| 2 | **Start Meta business verification** (the bottleneck) | hours → ~2 weeks |
| 3 | Register the real WhatsApp number in Twilio | 1–3 days review |
| 4 | Flip env vars on Railway + add the website button | 20 min |

You can run the bot end-to-end on the **Sandbox** (step 1) while Meta approval
(steps 2–3) grinds through in the background. **Start step 2 today.**

---

## What you need before you start
- A **credit card** (Twilio is pay-as-you-go; small amounts).
- A **phone number for the spa** that is **NOT** already used on the normal
  WhatsApp app, and can receive one SMS or voice call to verify. (A landline that
  takes a voice call works.)
- A **Facebook account** you can use to create a **Meta Business** account.
- Your spa's **legal business name + address** (Meta verifies these).

---

## STEP 1 — Test the bot immediately on the Twilio Sandbox

This proves the concierge works before any Meta paperwork.

1. Create a free account at **twilio.com** → verify your email + phone.
2. In the Twilio Console, go to **Messaging → Try it out → Send a WhatsApp
   message**. This is the **Sandbox**.
3. It shows a Twilio sandbox number and a **join code** like `join red-tiger`.
   From *your own* WhatsApp, send that exact text to the sandbox number. You're
   now connected to the sandbox.
4. In the Sandbox settings, find **"When a message comes in"** and set it to:
   ```
   https://spa-api.siamepos.co.uk/api/whatsapp/inbound
   Method: HTTP POST
   ```
5. On **Railway** (spa-api service → Variables), set — enough for the Sandbox:
   ```
   ANTHROPIC_API_KEY   = <your Claude API key>
   TWILIO_ACCOUNT_SID  = <from Twilio Console home>
   TWILIO_AUTH_TOKEN   = <from Twilio Console home>
   TWILIO_WHATSAPP_FROM= whatsapp:+14155238886   ← the sandbox number, "whatsapp:" prefix
   ```
   Redeploy (Railway does this automatically when you save variables).
6. From your phone, message the sandbox: *"hi do you do thai massage?"* — the
   concierge should reply with real treatments from your spa. 🎉

> **Signature note:** the Sandbox's webhook is signed with your Auth Token, which
> our endpoint verifies automatically. If you ever need to test without Twilio
> (e.g. curl), set `TWILIO_INBOUND_SECRET` and call
> `/api/whatsapp/inbound?s=<that-secret>` instead.

---

## STEP 2 — Start Meta business verification (the bottleneck — do this first)

A production WhatsApp number lives inside a **Meta WhatsApp Business Account
(WABA)**, which sits under a verified **Meta Business**.

1. Go to **business.facebook.com** → create a **Business Portfolio** if you don't
   have one (spa's legal name, your email).
2. Go to **Settings → Business Info** and complete every field (legal name,
   address, website, phone).
3. Go to **Security Centre → Start Verification** and submit **Business
   Verification**. Meta will ask for a document proving the business exists
   (e.g. a utility bill, business registration, or bank statement showing the
   name + address) and may call/email to confirm.
4. Submit and wait. **This is the slow part** — anywhere from a few hours to ~2
   weeks. Nothing else about the live number can finish until this passes, which
   is why you start it first.

---

## STEP 3 — Register the real WhatsApp number in Twilio

Do this once Meta verification is in progress/approved.

1. Twilio Console → **Messaging → Senders → WhatsApp senders → New sender**.
2. Twilio walks you through **Meta Embedded Signup** — log in with the Facebook
   account that owns the verified Business, and **connect your WABA**.
3. Provide:
   - The **phone number** for the spa (the one not on consumer WhatsApp). Twilio
     sends an OTP by SMS or voice to verify ownership.
   - A **WhatsApp display name** (e.g. "Baan Siam Spa"). Meta **reviews** this —
     it must match your real business and follow their naming rules. Review is
     usually 1–3 days.
   - Business profile bits: category, description, logo (optional but nice).
4. When the number is **Approved / Online**, note the number in the form
   `whatsapp:+44…`.

---

## STEP 4 — Point the live number at our backend + flip env vars

1. In Twilio, open the approved **WhatsApp Sender → messaging configuration** and
   set **"When a message comes in"** to:
   ```
   https://spa-api.siamepos.co.uk/api/whatsapp/inbound     (HTTP POST)
   ```
2. On **Railway** (spa-api → Variables), set/confirm the full set:
   ```
   ANTHROPIC_API_KEY     = <your Claude API key>
   CONCIERGE_MODEL       = claude-sonnet-5        (optional; this is the default)
   CONCIERGE_HOLD_TTL_MIN= 15                      (optional; minutes a slot is held)

   TWILIO_ACCOUNT_SID    = <Twilio Console>
   TWILIO_AUTH_TOKEN     = <Twilio Console>
   TWILIO_WHATSAPP_FROM  = whatsapp:+44XXXXXXXXXX  ← your APPROVED number

   PUBLIC_API_URL        = https://spa-api.siamepos.co.uk   (must already be set)
   ```
3. **Stripe:** in the Stripe Dashboard → Developers → Webhooks → your spa
   endpoint, **add the event `checkout.session.expired`** (alongside the existing
   `payment_intent.succeeded` / `checkout.session.completed`). This lets an unpaid
   hold's slot free up the moment Stripe expires the checkout. Endpoint URL stays
   `https://spa-api.siamepos.co.uk/api/stripe/webhook`.
4. Redeploy (automatic on save). Message the **real** number to confirm.

---

## STEP 5 — Add the "Chat on WhatsApp" button to the website

Put a click-to-chat link anywhere on the spa site (replace the number, no `+`,
no spaces):
```html
<a href="https://wa.me/44XXXXXXXXXX?text=Hi%2C%20I%27d%20like%20to%20book"
   target="_blank" rel="noopener">💬 Chat on WhatsApp</a>
```
The optional `?text=` pre-fills the customer's first message.

---

## Costs & limits (check current Twilio/Meta pricing)
- **Twilio:** a small monthly/number fee + a per-message fee on top of WhatsApp's
  own conversation fee. Pay-as-you-go.
- **WhatsApp:** inbound-customer chats open a **24-hour service window** where
  your replies are free, plus **1,000 free service conversations/month** per WABA
  — at one spa's volume this is effectively free. Only **proactive** messages
  outside the window (e.g. future appointment reminders) use **paid template
  messages**, which need Meta template approval first (not part of this build).

## Gotchas
- The spa's WhatsApp number **cannot** already be active on the normal WhatsApp
  app — Meta will refuse it. Use a fresh number or fully delete it from WhatsApp
  first.
- The **display name** review is separate from business verification and can
  bounce if the name looks generic or doesn't match the business.
- Webhook URL must be **exactly** `https://spa-api.siamepos.co.uk/api/whatsapp/inbound`
  — a trailing slash or `http` will fail Twilio's signature check.
- Nothing breaks before you set the keys: the endpoint just replies with an empty
  message and the bot stays silent until `ANTHROPIC_API_KEY` + Twilio vars exist.

---

## Appendix — Getting your Claude (Anthropic) API key

`ANTHROPIC_API_KEY` is the key that lets the spa talk to Claude. It powers the
**WhatsApp concierge** and the existing **Treatwell email AI** — set it once and
both work. Without it the concierge stays silent (no crash).

**Steps (~10 min):**
1. Go to **platform.claude.com** (the Claude Developer Platform) and sign up /
   log in with the business email.
2. **Add billing:** Settings → **Billing** → add a card and buy a small amount of
   credit (e.g. £5–£10 to start). It's pay-as-you-go — you're only charged for
   what you use.
3. **Set a spend limit** so there are no surprises: Billing → **Usage limits** →
   set a low monthly cap (e.g. £20). You can raise it later.
4. **Create the key:** Settings → **API keys** → **Create Key**, name it
   "SiamSpa Concierge". **Copy it now** — it's shown only once (starts with
   `sk-ant-...`). If you lose it, just create another and delete the old one.
5. On **Railway** (spa-api → Variables), set:
   ```
   ANTHROPIC_API_KEY = sk-ant-...        ← the key you copied
   CONCIERGE_MODEL   = claude-sonnet-5   ← optional; this is the default
   ```
   Save; Railway redeploys automatically.

**What it costs:** the concierge uses **Claude Sonnet 5** by default, priced at
about **$3 per million words-in / $15 per million words-out** (introductory
$2 / $10 through 31 Aug 2026). A whole booking conversation is only a few
thousand words, so in practice it's **a few pence per booking** — at one spa's
volume, a handful of pounds a month. Watch the real numbers on the platform's
**Usage** page for the first week and adjust your cap.

**Keep it secret:** the key is like a password to your Claude account. Never
paste it into the website, a git commit, or a chat. It lives only in Railway's
Variables. If it ever leaks, delete it on platform.claude.com and create a new
one — nothing else needs to change.

**Test it:** once set (plus the Twilio Sandbox from Step 1), message the spa on
WhatsApp — a reply means the key is working.

---

## Quick reference — what the code exposes
| Thing | Value |
|---|---|
| Inbound webhook (set in Twilio) | `POST https://spa-api.siamepos.co.uk/api/whatsapp/inbound` |
| Tools the AI uses | `get_treatments`, `get_spa_info`, `check_availability`, `hold_slot`, `request_human_handoff` |
| Hold length | `CONCIERGE_HOLD_TTL_MIN` (default 15 min) — unpaid holds auto-release |
| AI model | `CONCIERGE_MODEL` (default `claude-sonnet-5`) |
| Test-only tools surface | `/api/concierge/*`, gated by `CONCIERGE_SECRET` header — not needed for live |
