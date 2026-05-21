# Baan Siam Spa — SiamSpa demo site

Static demo site that lives at **www.siamepos.com** and serves as the sales
asset for SiamSpa, in the same way `client/MockUp Website/` (Baan Siam
restaurant at siamepos.net) does for the restaurant EPOS.

## Pages

| File | Purpose |
|------|---------|
| `index.html` | Hero · proof bar · 3 feature cards · founder pitch |
| `treatments.html` | **Live menu** fetched from `/api/widget/treatments`. Each "Book this →" deep-links into the widget at step 2 with the treatment pre-selected. |
| `therapists.html` | **Live profiles** fetched from `/api/widget/therapists`. The VDIT-counter page. Each "Book with X →" deep-links into the widget with the therapist pre-selected. |
| `about.html` | Story · what sets us apart |
| `contact.html` | Address · phone · hours · embedded map |

## Backend dependency

Every page loads the booking widget from the spa-api:
```html
<script src="https://spa-api.siamepos.co.uk/booking-widget.js" defer></script>
```

The widget needs the following endpoints, all already shipped in SPA-002 and
SPA-DEMO-001-PREP:

- `GET /api/widget/treatments`
- `GET /api/widget/therapists`  (returns `photo_url`)
- `GET /api/widget/availability`
- `POST /api/widget/book`

For local development the `assets/js/config.js` script auto-points at
`http://localhost:5050` when the page is served from `localhost`. You can
also force a backend with `?api=https://staging-spa-api...` in the URL.

## Seed data

The site renders treatments + therapists live from the backend, so the
spa-api needs to be seeded with the demo content before the site looks
good. Run:

```bash
cd spa-epos
node scripts/seed-demo.js
```

The script seeds rooms, treatment categories, 10 treatments, 4 therapists
(with Unsplash photo URLs and specialisms), and a sample availability
schedule. Re-running it is idempotent — existing rows are skipped.

## Deploy (Netlify)

1. **New Netlify site** → Import from Git → pick the restaurant-epos repo
2. **Base directory:** `spa-epos/mockup-website`
3. **Build command:** leave blank (static HTML)
4. **Publish directory:** `.`
5. **Domain:** add custom domain `www.siamepos.com` + apex `siamepos.com`
6. **DNS** in Namecheap:
   - `CNAME www → <netlify-site>.netlify.app`
   - `ALIAS @ → apex-loadbalancer.netlify.com` (or use Netlify DNS for the apex)
7. **HTTPS** auto-provisions via Let's Encrypt
8. Done — re-deploys are automatic on every push to `main`

## Brand system

Reuses the SPA-UI-001 brand:
- Slate Navy `#1e3a6e`
- Thai Gold `#C9A84C`
- Cream `#faf7f2`
- Playfair Display (headings) + Inter (body) + Georgia (wordmark)
- The lotus SVG matches the SiamSpa LoginScreen badge exactly.

## What this site is NOT

- Not a Stripe checkout — booking is "book first, pay on arrival"
- Not a CMS — content is seeded via the spa-api admin
- Not multilingual — English only, matching the Baan Siam restaurant pattern

## Reference

- Restaurant demo equivalent: `restaurant-epos/client/MockUp Website/` →
  https://www.siamepos.net
- SPA-DEMO-001 ticket: `spa-epos/SPA-DEMO-001-Sandy-Ticket.md`
