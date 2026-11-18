# Gestión de citas

PWA for a business to manage appointments. Customers book and receive reminders only through WhatsApp.

Work plan: [`odd/tasks/agenda-whatsapp-mvp.md`](odd/tasks/agenda-whatsapp-mvp.md).

## Structure

```
apps/
  web/        React + Vite PWA (React Router, TanStack Query, Tailwind)
  api/        Hono API (runs TypeScript directly on Node 24)
packages/
  db/         Drizzle schema, migrations and DB client
  shared/     Zod schemas and types shared by web and api
docker/       Dockerfiles and nginx config
```

## Requirements

- Node 24 (`.nvmrc`)
- pnpm 12
- Docker with Compose

## Run everything in Docker

```bash
docker compose up -d --build
```

| Service | URL |
|---|---|
| Web (nginx, proxies `/api`) | http://localhost:8080 |
| Login | http://localhost:8080/login |
| API | http://localhost:3000/api/health |
| PostgreSQL | `localhost:5433` (user/password/db: `gestion`) |

The API applies pending migrations on start (`RUN_MIGRATIONS=true`).

## Authentication

Better Auth (email + password, Drizzle adapter) is mounted at `/api/auth/*`.
Public sign-up is disabled; the only user is the business owner created with the
CLI below. `GET /api/me` returns `401` without a session and, with one, the user
(`id`, `email`, `name`) plus its business (`id`, `name`). The web app redirects
protected routes to `/login` and offers a logout button on the home page.

### Create the owner user

Sign-up is disabled: the single business owner is created from the CLI, which
also creates the business row (if it does not exist yet) and links the user to it
through `business_id`. The password is hashed by Better Auth.

```bash
# Docker stack
docker compose exec api node apps/api/src/auth-cli.ts \
  --email owner@example.com --password 'change-me-please' \
  --name 'Dueña' --business 'Peluquería Centro'

# Or from the host with the DATABASE_URL/BETTER_AUTH_* vars of the stack exported
pnpm auth:create-user --email owner@example.com --password 'change-me-please' \
  --name 'Dueña' --business 'Peluquería Centro'
```

Then open http://localhost:8080/login and sign in with that email and password.
Re-running the command for an existing email reports `User already exists` and
creates no duplicate; if that user has no business yet (a partial earlier run),
it is linked to the business and reported as `User linked to business`. If
sign-up fails, the CLI prints one error line, exits 1 and removes the business
it had just created. Every option also falls back to an env var, so
`AUTH_EMAIL`, `AUTH_PASSWORD`, `AUTH_NAME` and `BUSINESS_NAME` work too.

## Agenda API

Every route below requires a valid session cookie (`401 {"error":"unauthorized"}`
otherwise) and works on the session user's business; the business id is never read
from the request. Request and response shapes are Zod schemas in
`packages/shared/src/agenda.ts`, and the API validates input with them.
Errors are `{"error": "<code>"}`.

| Endpoint | Body / query | Success | Errors |
|---|---|---|---|
| `GET /api/appointments?from=&to=` | `from`, `to`: ISO 8601 instants (`Z` or offset, years 2000-2100), `to` > `from`, at most 62 days apart | `200 {appointments:[...]}` ordered by start, any status, with `customerPhone`, `customerName`, `serviceName` | `400 invalid_request` |
| `POST /api/appointments` | `{customerPhone, customerName?, serviceId, startsAt}` | `201` appointment; `endsAt` = `startsAt` + service duration; customer upserted by phone | `400 invalid_request`, `404 not_found` (service unknown or of another business), `409 slot_taken` |
| `PATCH /api/appointments/:id` | `{startsAt}`: moves it keeping its duration | `200` appointment | `400 invalid_request`, `404 not_found` (unknown, cancelled or of another business), `409 slot_taken` |
| `POST /api/appointments/:id/cancel` | none | `200` appointment with `status: "cancelled"` (frees the slot) | `400 invalid_request`, `404 not_found` (unknown, already cancelled or of another business) |
| `GET /api/services` | | `200 {services:[{id,name,durationMinutes,active}]}` | |
| `POST /api/services` | `{name, durationMinutes}` (1 to 1440) | `201` service | `400 invalid_request` |
| `GET /api/opening-hours` | | `200 {hours:[{weekday,opensAt,closesAt}]}` ordered by weekday and opening time | |
| `PUT /api/opening-hours` | `{hours:[{weekday,opensAt,closesAt}]}` replaces the whole week; `weekday` 0-6, times `HH:MM`, `closesAt` > `opensAt` | `200` the saved week | `400 invalid_request` |

Details:

- The list window is half-open: an appointment is listed when it starts before `to`
  and ends after `from`, so one ending exactly at `from` or starting exactly at `to`
  is not.
- `customerPhone` is normalized to digits only (spaces, dashes, parentheses and a
  leading `+` are stripped) and must then have 8 to 15 digits.
- Appointments are single-agenda: an overlap with another booked appointment is
  `409 slot_taken`; back-to-back is fine. Booking outside opening hours is not
  rejected yet.
- Every instant (`startsAt`, `from`, `to`) must fall in the years 2000-2100, else `400`.
  `endsAt` is computed from epoch milliseconds, so a 24 h appointment is exactly 24 h even when moved.
- Concurrent bookings and moves into one slot yield exactly one success and `409 slot_taken` for the
  rest: a Postgres deadlock or serialization failure is retried once and, if it persists, answered as `409`.
- A booking that loses the overlap race (`409`) can still leave the customer row it upserted.

Example (through nginx, after creating the owner with the CLI above):

```bash
U=http://localhost:8080
curl -s -c jar -H 'content-type: application/json' -H "origin: $U" \
  -d '{"email":"owner@example.com","password":"change-me-please"}' $U/api/auth/sign-in/email

curl -s -b jar -H 'content-type: application/json' \
  -d '{"name":"Corte","durationMinutes":30}' $U/api/services          # 201 {"id":"<serviceId>",...}

curl -s -b jar -H 'content-type: application/json' \
  -d '{"customerPhone":"+57 300 123-4567","customerName":"Ana","serviceId":"<serviceId>","startsAt":"2031-03-10T14:00:00Z"}' \
  $U/api/appointments                                                 # 201, endsAt 14:30; same slot again: 409 {"error":"slot_taken"}

curl -s -b jar -X PATCH -H 'content-type: application/json' \
  -d '{"startsAt":"2031-03-10T16:00:00Z"}' $U/api/appointments/<appointmentId>

curl -s -b jar -X POST $U/api/appointments/<appointmentId>/cancel

curl -s -b jar "$U/api/appointments?from=2031-03-10T00:00:00Z&to=2031-03-11T00:00:00Z"

curl -s -b jar -X PUT -H 'content-type: application/json' \
  -d '{"hours":[{"weekday":1,"opensAt":"09:00","closesAt":"17:00"}]}' $U/api/opening-hours
```

## Data model

Every table carries `business_id` (foreign key to `businesses`), so the app can
serve several businesses later; today there is one. Schema: `packages/db/src/schema.ts`;
data-layer functions: `packages/db/src/agenda.ts`.

| Table | Contents |
|---|---|
| `customers` | WhatsApp customers: `phone` (E.164), optional `name`; unique per business + phone |
| `services` | `name`, `duration_minutes` (> 0), `active` |
| `opening_hours` | weekly ranges: `weekday` 0-6, `opens_at` < `closes_at`; several ranges per weekday |
| `appointments` | `customer_id`, `service_id`, `starts_at` < `ends_at` (`timestamptz`), `status` `booked` or `cancelled` |

An appointment can only reference a customer and a service of its own business:
`customers` and `services` are unique on `(id, business_id)`, and `appointments`
has composite foreign keys `(customer_id, business_id)` and `(service_id, business_id)`.

No-overlap rule: each business has a single agenda, and a Postgres exclusion
constraint (`appointments_no_overlap`, `btree_gist`) rejects two non-cancelled
appointments of the same business whose time ranges overlap. Back-to-back
appointments (one ends when the next starts) are allowed, and cancelling frees
the slot. `createAppointment` maps the violation to a `SlotTakenError`.
The constraint and the `btree_gist` extension are written by hand in
`packages/db/migrations/0002_data_model.sql` (drizzle-kit cannot express them), so
keep both when editing migrations and do not use `drizzle-kit push`, which does
not know about them.

## Local development

Run only Postgres in Docker and the apps on your machine:

```bash
pnpm install
docker compose up -d postgres
export DATABASE_URL=postgres://gestion:gestion@localhost:5433/gestion
export BETTER_AUTH_SECRET=dev-only-better-auth-secret-change-me-0123456789
export BETTER_AUTH_URL=http://localhost:5173
pnpm db:migrate
pnpm dev:api        # http://localhost:3000
pnpm dev:web        # http://localhost:5173 (proxies /api to :3000)
```

`BETTER_AUTH_URL` must be the origin the browser uses (the web dev server here,
nginx in the Docker stack) so session cookies pass Better Auth's origin check.
In local development the owner is created with:

```bash
pnpm auth:create-user --email owner@example.com --password 'change-me-please' \
  --name 'Dueña' --business 'Peluquería Centro'
```

## Environment variables

| Variable | Used by | Default |
|---|---|---|
| `DATABASE_URL` | api, db scripts, auth CLI | none in api (required); `postgres://gestion:gestion@localhost:5433/gestion` in `drizzle.config.ts` |
| `PORT` | api | `3000` |
| `RUN_MIGRATIONS` | api | off; `true` applies migrations on start |
| `BETTER_AUTH_SECRET` | api, auth CLI | none in api (required when `NODE_ENV=production`; dev falls back to a dev-only constant); `dev-only-better-auth-secret-change-me-0123456789` in compose |
| `BETTER_AUTH_URL` | api, auth CLI | `http://localhost:$PORT` in api; `http://localhost:8080` in compose (the nginx origin the browser uses) |
| `BETTER_AUTH_TRUSTED_ORIGINS` | api (Better Auth, optional) | comma-separated extra origins allowed for cookie requests |
| `AUTH_EMAIL` / `AUTH_PASSWORD` / `AUTH_NAME` / `BUSINESS_NAME` | auth CLI | none; env fallbacks for the CLI flags |
| `API_URL` | web dev server proxy | `http://localhost:3000` |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | compose | `gestion` |
| `POSTGRES_PORT` | compose (host port) | `5433` |

The compose defaults are for local development only. Set real values for any shared or public deployment.

## Scripts

| Command | What it does |
|---|---|
| `pnpm test` | Run all tests (the API tests need `docker compose up -d postgres`) |
| `pnpm typecheck` | Type-check every package |
| `pnpm build` | Build the web app |
| `pnpm db:generate --name <name>` | Create a migration from `packages/db/src/schema.ts` |
| `pnpm db:migrate` | Apply migrations to `DATABASE_URL` |
| `pnpm auth:create-user --email <e> --password <p> --name <n> --business <b>` | Create the single owner (idempotent on email) |
