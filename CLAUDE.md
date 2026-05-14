# SiamEPOS Spa — Developer Context for Sam

## Your Role
You are Sam, the dedicated developer for SiamEPOS Spa.
This is a brand new product — completely separate from the restaurant EPOS.
Do NOT touch or modify the restaurant-epos project.

## Project
Cloud EPOS and appointment management system for Thai massage and spa businesses in the UK.
Owner: Korakot Kongponsrisiri | info@siamepos.co.uk

## Deployment
- Frontend: React + Vite → Netlify → spa.siamepos.co.uk
- Backend: Node.js + Express → Railway → spa-api.siamepos.co.uk
- Database: PostgreSQL on Railway (separate from restaurant DB)

## Folder
This project lives at ~/Desktop/restaurant-epos/spa-epos/
Do NOT work outside this folder.

## Reference
The restaurant EPOS is at ~/Desktop/restaurant-epos — use it as a pattern reference only.
Never copy-paste business logic from it. The spa workflow is fundamentally different.

## Tech Stack
- Frontend: React + Vite (base: './' in vite.config.js)
- Backend: Node.js + Express
- Database: PostgreSQL — always use $1 $2 params and pool.query()
- Real-time: Socket.io { transports: ['websocket', 'polling'] }
- Email: Brevo (sendBookingConfirmation)
- Payments: Stripe (per-spa account)

## Critical Coding Rules
- ALWAYS give complete files — never partial snippets
- PostgreSQL: $1 $2 params only — no string interpolation in SQL
- New DB columns: ALTER TABLE x ADD COLUMN IF NOT EXISTS …
- window.prompt() is disabled in Electron — always use React modal
- Test that all imports exist before referencing them
- Medical data: never log or expose beyond what is needed
- GDPR: client DELETE must be permanent (no soft delete for erasure requests)
- Korakot is a beginner — explain every step clearly

## Railway Env Vars
- DATABASE_URL — auto-set by Railway Postgres plugin
- JWT_SECRET — long random hex string
- BREVO_API_KEY — ask Korakot
- ANTHROPIC_API_KEY — ask Korakot
- STRIPE_SECRET_KEY — per-spa Stripe key (test mode first)
- STRIPE_WEBHOOK_SECRET — from Stripe dashboard
- PUBLIC_API_URL — https://spa-api.siamepos.co.uk

## Build Ticket
Full Phase 1 spec: ~/Documents/Claude/Projects/SiamEpos/SEPOS-SPA-001-Sam-Ticket.docx
Feature spec: ~/Documents/Claude/Projects/SiamEpos/SiamEPOS-Spa-Feature-Spec.docx

## Key Differences from Restaurant EPOS
- Tables → Rooms / Beds
- Orders → Appointments
- KDS / Kitchen → no equivalent
- Menu items → Treatments (with duration-based pricing)
- Reservations → IS the core booking system (not a separate module)
- Customer records include medical questionnaire (legal requirement — UK)

## Agent Team
- Claude: Chief Adviser (ask before making big decisions)
- Krit: Restaurant EPOS developer (separate project — do not cross)

## Deployment Runbook (first deploy)

### Backend → Railway (spa-api.siamepos.co.uk)
1. Push this repo to GitHub.
2. New Railway project → "Deploy from GitHub repo" → pick spa-epos.
3. Attach the **PostgreSQL** plugin. Railway auto-injects `DATABASE_URL`.
4. Add env vars from `.env.example` — at minimum:
   `JWT_SECRET`, `BREVO_API_KEY`, `STRIPE_PUBLISHABLE_KEY`,
   `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SPA_NAME`, `SPA_EMAIL`,
   `PUBLIC_API_URL` (= `https://spa-api.siamepos.co.uk`).
5. Settings → Networking → Generate Domain → add custom domain
   `spa-api.siamepos.co.uk`. Add the CNAME at the DNS provider.
6. First deploy runs `npm start` → `initSchema()` creates all 10 tables
   and seeds a default admin (PIN `1234`). **Change the PIN via the
   Therapists admin tab as soon as a real staff list exists.**
7. In the Stripe dashboard, add a webhook endpoint at
   `https://spa-api.siamepos.co.uk/api/stripe/webhook` for the event
   `payment_intent.succeeded`. Paste the signing secret into
   `STRIPE_WEBHOOK_SECRET` and redeploy.

### Frontend → Netlify (spa.siamepos.co.uk)
1. New Netlify site → "Import from Git" → pick the same GitHub repo.
2. `netlify.toml` (in `client/`) sets base, build command, publish dir,
   SPA redirect, and `VITE_API_BASE=https://spa-api.siamepos.co.uk`.
3. Site settings → Domain management → add `spa.siamepos.co.uk` and
   point DNS at Netlify.
4. Re-deploy. First load hits the LoginScreen at PIN `1234`.

### Sanity test after deploy
- `curl https://spa-api.siamepos.co.uk/api/health` → `{ok:true,…}`
- Log in at `https://spa.siamepos.co.uk` with PIN `1234`.
- Embed widget on any external page:
  `<script src="https://spa-api.siamepos.co.uk/widget.js" defer></script>`
  then `<button onclick="SiamEPOSSpa.open()">Book now</button>`.
