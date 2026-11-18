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
| T2 | S6 | worker (Risk: item 2 auth) | done (native review blocked) | 29a1de2 |
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
- L8 (user): "dale" → start T2. Defaults chosen by the coordinator (change on request): email+password via Better Auth with its Drizzle adapter; public sign-up disabled; the single owner is created with a CLI (`pnpm auth:create-user`) that also ensures the business row and links the user through `business_id`; `/api/auth/*` mounted in Hono, `GET /api/me` behind a session guard; web gets `/login` (React Hook Form + Zod), protected routes and logout; shadcn/ui deferred to T4; `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` env vars with dev-only compose defaults.
- L9 (evidence T2): writer RED→GREEN, `pnpm test` 14/14 (re-run by coordinator: 14/14), typecheck and build ok; curl via nginx: /api/me 401 → sign-in 200 + cookie → /api/me 200 {user,business} → sign-out → 401; public sign-up 400 `EMAIL_PASSWORD_SIGN_UP_DISABLED`; prod without `BETTER_AUTH_SECRET` exits 1. Independent verifier: PASS on S6/L8, no blockers. Advisories: A1 cookie not Secure over dev http (https → `__Secure-` + Secure, probed); A2 `--password` visible in `ps`/history (env `AUTH_PASSWORD` exists); A4 user with null `business_id` gets 401 on /api/me. Deviations: owner queries in `packages/db/src/owner.ts` (drizzle peer split); CLI uses a never-mounted sign-up-enabled Better Auth instance; web uses fetch instead of the better-auth client. Native review lineage `review-c172c649f18528ce` (lenses risk, reliability) blocked: reviewer model `nan/deepseek-v4-flash` exhausted its output budget on reasoning; no verdict.
- L10 (user): "dale la 1" → fix the T2 review findings: (a) `createOwner` re-run must link an existing user whose `business_id` is NULL (and the CLI must report it); (b) `RequireAuth` must not treat API/network errors as "no session"; (c) login page must show a distinct message for non-credential failures; (d) logout failure must be shown and must not navigate away or clear the session. Source: advisory findings R3-owner-partial-failure, R3-guard-error-as-logout, R3-login-error-conflation, R3-logout-failure-silent (native review `review-c172c649f18528ce`, approved).
