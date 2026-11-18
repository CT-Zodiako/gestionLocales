# agenda-whatsapp-mvp

PWA for a single business to manage appointments; end customers book and get reminders only through WhatsApp (Cloud API).
Designed to become a multi-business product later (`business_id` everywhere), but only one business is built now.

## Specs

- S1. Product shape: "solo el negocio , el cliente solo va a utilizar whatsapp, por ahra un solo negocio la idea es ahcer un producto general". The business uses the PWA; customers use only WhatsApp. Data model carries `business_id` from day one.
- S2. Delivery as PWA, not native app: "la idea es tener un pwd, ya que no quiero hacer aplicacion para celular para no desplegar en play store o apple store".
- S3. Stack: "react, hono, postgrasql, docker para contenerizar todo ,drizzel orm, better auth, react hook form, tanstack query, shadcn/ui tailwind, zustand". Plus Zod ("si metamos zod"), pg-boss for reminders ("3 vale probamos"), React Router (user selected "React Router (recomendado)").
- S4. Purpose: "una app que envie recordaoriso whatsapp y me ayude a agendar citas", about "100 persoans al mes".
- S5. Stage 1 (base): pnpm monorepo (`apps/web`, `apps/api`, `packages/db`, `packages/shared`), Docker Compose with Postgres + api + web, Hono and React responding, Drizzle with its first migration.
- S6. Stage 2 (login): Better Auth with one business user.
- S7. Stage 3 (data model): business, services, opening hours, appointments, with a DB constraint that prevents overlapping bookings.
- S8. Stage 4 (agenda PWA): day and week views; create, move, cancel appointments; installable PWA.
- S9. Stage 5 (WhatsApp): idempotent webhook and menu-based bot (lists/buttons) to book, view, cancel.
- S10. Stage 6 (reminders): pg-boss worker sending `utility` templates on confirmation and 24 h before.

## Tasks

| ID | Specs | Route | Status | Commit |
|---|---|---|---|---|
| T1 | S3, S5 | inline | done | 5dd5a7c |
| T2 | S6 | inline (Risk: item 2 auth) | pending | |
| T3 | S1, S7 | inline (Risk: item 4 concurrency) | pending | |
| T4 | S2, S8 | inline | pending | |
| T5 | S4, S9 | inline (Risk: item 2 credentials) | pending | |
| T6 | S4, S10 | inline | pending | |

## Log

- L1 (user): "como funciona la api de whatsapp apra enviar mensajes y cuanto es el costo"
- L2 (user): "es decir si yo quiero hacer una app que envie recordaoriso whatsapp y me ayude a agendar citas y tneog aproxiamdamente 100 persoans al mes cuannto cobraria"
- L3 (user): "primero la idea es tener un pwd, ya que no quiero hacer aplicacion para celular para no desplegar en play store o apple store"
- L4 (user): "solo el negocio , el cliente solo va a utilizar whatsapp, por ahra un solo negocio la idea es ahcer un producto general , todavia esto pensado el stack"
- L5 (user): "quiero utlizr esta tecnologias para probar , react, hono, postgrasql, docker para contenerizar todo ,drizzel orm, better auth, react hook form, tanstack query, shadcn/ui tailwind, zustand"
- L6 (user): "si metamos zod, para la 2 que es lo general que utilia react?, 3 vale probamos" → router choice: React Router (recomendado). Authorized to create this plan and start stage 1.
- L7 (evidence T1): api tests 3/3 pass, typecheck ok, web build ok; `docker compose up` → /api/health 200 `{"status":"ok","database":"up"}` direct and via nginx, SPA fallback 200, migration created `businesses`. `@hono/node-server` pinned to 2.1.8 (2.1.9 blocked by pnpm minimumReleaseAge). `.env.example` blocked by harness safety policy; env vars documented in README instead.
