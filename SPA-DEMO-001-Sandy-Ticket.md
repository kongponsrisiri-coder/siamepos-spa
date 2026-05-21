# SiamSpa
## SPA-DEMO-001 — Mockup Demo Website ("Baan Siam Spa")
**Assigned to:** Sandy   |   **Priority:** P1   |   **Date:** 21 May 2026

---

## 1. Why This Ticket Exists Now

We have **www.siamepos.com** free to use as a sister demo site to siamepos.net
(Baan Siam restaurant). VDIT is actively cold-calling Thai spa shops pitching
online booking + therapist selection, and we just shipped SPA-002 which is our
direct counter — but a code feature isn't a sales asset until you can
**point a prospect at a real spa website** that shows the whole loop:
treatment menu → therapist profile → instant booking with chosen therapist →
confirmation → backend appointment.

A demo spa site does for SiamSpa sales what Baan Siam (siamepos.net) does for
the restaurant EPOS — turns a feature list into a "you can have this website
+ booking system live this week" pitch.

## 2. Ticket Summary

| | |
|---|---|
| **Ticket** | SPA-DEMO-001 |
| **Feature** | Public mockup demo site for SiamSpa |
| **Priority** | P1 — sales asset, gates SiamSpa demos to prospects |
| **Assigned to** | Sandy |
| **Depends on** | (a) SPA-002 pushed + Railway boot of `spa-api.siamepos.co.uk`, (b) prerequisite ticket SPA-DEMO-001-PREP (below) — Sam adds `photo_url` to therapists |
| **Deploy to** | **www.siamepos.com** (Netlify, separate site from siamepos.co.uk + siamepos.net) |

## 3. Brand Identity

Two options — Korakot to choose:

**A — "Baan Siam Spa"** (recommended)
- Sister to Baan Siam restaurant. Same brand family, same demo prospect can see
  "you're already familiar with this name from the restaurant demo — here's
  what the spa side looks like."
- Risk: a real visitor Googling "Baan Siam" looking for the restaurant might
  land on the spa. Mitigation: clear footer linking back to the restaurant
  site.

**B — "Lotus Spa London"** (or "Siam Lotus Spa")
- Ties to the existing lotus SVG already used in the SiamSpa UI (TopNav,
  LoginScreen) from SPA-UI-001.
- Independent identity, no brand confusion.

Sandy to mock both in the index hero and Korakot picks before building out
the rest of the pages.

## 4. Page List (5 pages + booking widget embedded everywhere)

| Page | Purpose |
|------|---------|
| **index.html** | Hero, "Book your treatment" CTA, three feature cards (treatments / therapists / location), proof bar, footer. |
| **treatments.html** | Live menu fetched from `GET /api/widget/treatments`. Grouped by category. Each card: name, duration, price, description. "Book this treatment" → opens widget pre-selected. |
| **therapists.html** ⭐ | **THE VDIT-COUNTER PAGE.** One profile card per therapist fetched from `GET /api/widget/therapists`: photo (from new `photo_url`), name, specialisms, "Book with {name}" button → opens widget at step 2 with this therapist pre-selected. |
| **about.html** | Story / philosophy / Thai massage tradition / what makes us different. |
| **contact.html** | Address, phone, opening hours, embedded Google map, parking note. |

**Booking widget** — every page carries `<script src="https://spa-api.siamepos.co.uk/booking-widget.js" defer></script>`
in the `<head>`, and the "Book" CTAs call `SiamEPOSSpa.open()` (with an
optional pre-selected treatment/therapist once we wire that in — see §7 for
the small API extension).

## 5. Backend Endpoints to Consume

All already live after SPA-002 deploys — no new server work needed except
the small extension in §7:

- `GET /api/widget/treatments` → treatments grouped by category
- `GET /api/widget/therapists` → `{ id, name, specialisms, photo_url }` after PREP ticket lands
- `GET /api/widget/availability?treatment_id=&date=&therapist_id=` → slot list
- `POST /api/widget/book` → creates appointment, returns therapist + room names

## 6. Prerequisites (Sam — do before handing to Sandy)

These are quick — Sam to ship as a small follow-up before Sandy starts:

### SPA-DEMO-001-PREP (Sam, ~30 min)

1. `ALTER TABLE therapists ADD COLUMN IF NOT EXISTS photo_url TEXT` in
   `src/db/database.js` (next to the existing `specialisms` migration).
2. Extend `GET /api/widget/therapists` to return `photo_url`.
3. Extend `src/routes/therapists.js` SELECT + POST + PUT to handle `photo_url`.
4. Add photo URL input to `TherapistSection.jsx` admin modal (next to the
   Specialisms field).
5. Widget step 2 — if a therapist has `photo_url`, render `<img>` in the
   circle instead of initials. Initials stay as the fallback.
6. **Optional pre-select API** — extend the public surface in
   `client/public/widget.js`:
   ```js
   window.SiamEPOSSpa.open({ treatmentId: 12, therapistId: 3 });
   ```
   so the demo site's "Book with Anong" buttons can deep-link straight into
   the right step.

## 7. Content Needed from Korakot

For Sandy to populate the demo site she needs the **actual seed data** that
will live in the spa-api production DB:

- **Spa brand pick** (A or B from §3) + logo svg + 1–2 sentence tagline
- **Address** (real or fictional — Soho, Hampstead, Notting Hill all work as
  premium spa locations)
- **Phone** (use the SiamEPOS demo number — same one used for Baan Siam if
  there is one)
- **3–4 therapists** with: Thai/Western first name, headshot photo URL
  (stock photo is fine — Unsplash "spa therapist asian" gives good results),
  one-line bio, specialisms string
- **6–10 treatments** across 2–3 categories (e.g. Thai Massage, Aromatherapy,
  Hot Stone) with: name, duration (60/90/120 min), price, 1-line description
- **5–8 ambience photos** for the index/about/treatments page headers
  (Unsplash "Thai spa interior" / "massage room")

## 8. Build Location & Deployment

- **Folder:** `spa-epos/mockup-website/` (mirrors the
  `restaurant-epos/client/MockUp Website/` pattern)
- **Netlify site:** new project, deploy from the same GitHub repo,
  `base = spa-epos/mockup-website`, no build command (static HTML),
  `publish = .`
- **DNS:** Namecheap → CNAME `www` → Netlify URL, plus apex `siamepos.com`
  → ALIAS to Netlify
- **HTTPS:** Netlify auto-provisions

## 9. Mobile First (team rule, Korakot directive 2026-05-16)

Every page tested on mobile first:
- 44px min tap targets on all CTAs
- 16px+ form inputs (no iOS zoom)
- Hamburger nav at < 768px
- No horizontal scroll
- "Book your treatment" CTA visible above the fold on phone
- Booking widget already mobile-first from SPA-002 — no extra work there

## 10. Acceptance Criteria

- 5 pages render on mobile + desktop with consistent header/footer
- Treatments menu shows live data from the spa backend (not hard-coded)
- Therapist profiles show live data + photos
- Every "Book" CTA opens the SPA-002 booking widget
- "Book with {Therapist}" pre-selects that therapist in widget step 2
- Booking through the widget lands as a real appointment in the SiamSpa
  Admin → Trading and AppointmentScreen
- Confirmation email arrives via Brevo (if BREVO_API_KEY set on spa-api)
- Lighthouse mobile score ≥ 90 on index + treatments
- Site loads in under 2s on a throttled 3G profile (no big hero videos)

## 11. What NOT to Build

- **No Stripe checkout** on the demo site — booking is "book first, pay on
  arrival" (matches what real Thai spas do)
- **No multi-location selector** — single fictional spa
- **No Thai-language toggle** — English-only matches Baan Siam pattern (see
  Korakot's "site_language_english_only" memory)
- **No CMS / admin interface** — this is a static demo, content is seeded
  via the spa-api admin
- **No native app banner**
- **No live chat widget** (Intercom / Tawk etc.)

## 12. Style Guidance for Sandy

Use the same brand system landed in SPA-UI-001:

- **Primary:** Slate Navy `#1e3a6e`
- **Accent:** Thai Gold `#C9A84C`
- **Background:** Warm off-white `#faf7f2`
- **Headings:** Playfair Display
- **Body:** Inter
- **Lotus motif:** the existing SVG from SiamSpa UI

The visitor should feel they've already arrived at a "premium calm Thai spa"
before clicking anything — soft cream backgrounds, generous whitespace, warm
gold accents, no aggressive red CTAs.

## 13. Reference

- Baan Siam restaurant demo: `restaurant-epos/client/MockUp Website/` and
  live at https://www.siamepos.net — same scale, same pattern, same purpose.
- SiamSpa app brand: `spa-epos/client/src/styles.css` + the navy TopNav in
  the post-SPA-UI-001 build (Krit Cowork 2026-05-20).
- VDIT competitive note in TEAM-STATUS.md Announcements 2026-05-19 — read
  before designing the therapists page; that's the page that wins the deal.

## 14. Notes for Sandy

- Read **TEAM-STATUS.md** Announcements + Sam's SPA-002 handoff first —
  context on why the therapists page is the marquee feature.
- This is a **sales asset**, not a client site — polish > breadth.
- The MockUp Website folder for restaurant lives at `restaurant-epos/client/MockUp Website/`
  — pattern-match the structure, don't reinvent.
- Don't touch any code in `spa-epos/src/`, `spa-epos/client/src/`, or
  `client/public/widget.js`. The mockup-website folder is your sandbox.
- If you need a backend endpoint that doesn't exist yet — flag it to Sam,
  don't paper over it with hard-coded data.

Good luck Sandy — this is the page that turns the SiamSpa pitch from "we
have a feature" into "look, here's the website running it." 🪷
