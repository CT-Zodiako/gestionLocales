# Gestión de citas

PWA for a business to manage appointments. Customers book and receive reminders only through WhatsApp.

Work plan: [`odd/tasks/agenda-whatsapp-mvp.md`](odd/tasks/agenda-whatsapp-mvp.md).

## Structure

```
apps/
  web/        React + Vite PWA (React Router, TanStack Query, Zustand, shadcn/ui, Tailwind)
  api/        Hono API (runs TypeScript directly on Node 24)
packages/
  db/         Drizzle schema, migrations and DB client
  shared/     Zod schemas and types shared by web and api
docker/       Dockerfiles and nginx config
e2e/          Playwright end-to-end tests (run against the Docker stack)
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

## Web app

After login (`/login`), `/` shows the agenda: the business name and logout in the
header, a "Nueva cita" button, date navigation (previous / today / next), a
day|week toggle and a "Canceladas" toggle. The UI is in Spanish and mobile-first
(checked at 375 px, 40 px touch targets); times are entered and shown in the
browser's timezone.

- **Day view**: a scrollable time grid from 07:00 to 21:00 (it grows when an
  appointment falls outside that window). Each appointment is a block positioned
  by its start and sized by its duration, showing the customer name (or `+phone`
  when there is no name) and the service.
- **Week view**: seven columns, Monday first, with compact blocks (customer only).
- **Cancelled appointments** are hidden by default; the "Canceladas" toggle shows
  them muted (grey, struck through, labelled "Cancelada").
- Loading, empty ("No hay citas para este día.") and error states; the error
  state has a "Reintentar" button, and it also appears when the browser is
  offline (the appointments query always attempts the request).
- State: the selected date, the view and the cancelled toggle live in a Zustand
  store (`apps/web/src/stores/agenda-store.ts`, UI state only); the appointments
  come from `GET /api/appointments?from&to` through TanStack Query, with the
  visible range in the query key. Signing in or out clears the whole query cache,
  so a second owner in the same tab never sees the previous owner's data.
- UI components are shadcn/ui (Radix, Tailwind 4) under `apps/web/src/components/ui`
  (`button`, `toggle`, `toggle-group`, `dialog`, `input`, `label`, `select`); add more with
  `pnpm dlx shadcn@latest add <component>` inside `apps/web`.

### Creating, moving and cancelling appointments

Forms use React Hook Form with Zod. The validation schemas live in
`apps/web/src/lib/appointment-forms.ts` and reuse the shared ones (`phoneSchema`,
`instantSchema` and the request body schemas of `@gestion/shared`); the writes are TanStack Query
mutations (`apps/web/src/lib/appointments.ts`) that wait for the refetch of the appointment
queries before the dialog closes, and the `fetch` helpers with their typed `ApiError`
(`status` and the API's `code`) are in `apps/web/src/lib/api.ts`.

- **Nueva cita**: the toolbar button, or a tap/click on an empty hour of the day grid (the
  hour is prefilled; these hour targets are for the pointer, keyboard users have the toolbar
  button). The dialog asks for the customer phone (spaces, dashes, parentheses and a leading
  `+` are accepted; 8 to 15 digits), an optional name, the service, the date and the time, and
  shows the end time from the service duration. The date and time are in the browser timezone and are
  sent as an ISO instant. After a booking (or a move) to a day that is not on screen the agenda
  jumps to that day.
- **Nuevo servicio**: while the business has no (active) services the booking dialog shows an inline form
  (name, duration in minutes) that calls `POST /api/services` and selects the new service. It is the only
  place services are created from the UI; editing them is not available yet.
- **Detail**: clicking or pressing Enter on an appointment block opens its detail with
  **Mover** (date and time form; the duration is kept) and **Cancelar cita** (asks for a
  confirmation first; "No, volver" keeps it). A cancelled appointment (shown with the toggle)
  opens read-only.
- **Errors** keep the dialog open and everything typed: a client-side validation message under
  each field (announced with `role="alert"`, no request is sent); `409` "Ese horario ya está ocupado";
  `404` (the appointment was cancelled meanwhile, or the service no longer exists) says so and refreshes the
  agenda (or the services); `400` shows one message for the whole form (the API answers
  `invalid_request` without field details, so field messages come from the client schemas);
  anything else (500, network) shows "Ocurrió un error. Inténtalo de nuevo.".
- **Accessibility**: labelled controls, focus moves into the dialog and returns to the button, hour or
  block that opened it (also when that block is gone, then to the agenda), Escape closes, a tap outside
  does not (so typed data is not lost), and while a request is in flight the submit button is disabled
  and the dialog cannot be closed, so a double click sends one request.

Run it with the Docker stack (above) at http://localhost:8080, or in development
(see "Local development") at http://localhost:5173.

### Installing the PWA

The app is an installable PWA (web manifest, 192/512 and maskable icons, service
worker generated by `vite-plugin-pwa`). The service worker only precaches the app
shell (built JS/CSS/HTML and icons) so the shell opens offline; it never caches or
intercepts `/api/*`, so data always comes from the network and an offline API call
fails instead of returning stale data. It is generated by `pnpm build` only (the
dev server does not register one).

- Chrome / Edge (desktop and Android): open the app and use the install icon in the
  address bar, or the browser menu, "Install app" / "Add to Home screen".
- Safari on iOS: Share, "Add to Home Screen".
- Browsers only offer installation on `https://` or `localhost`; serve a real
  deployment over HTTPS.
- nginx serves `sw.js`, `registerSW.js`, `manifest.webmanifest` and `index.html`
  with `Cache-Control: no-cache` so new releases are picked up; a new worker
  activates on the next load.

### End-to-end tests

Playwright runs against the Docker stack, so build and start it first:

```bash
docker compose up -d --build
pnpm install
pnpm exec playwright install chromium   # once
pnpm e2e
```

Specs, run in alphabetical order: `e2e/agenda.spec.ts` (views, navigation, login),
`e2e/appointments.spec.ts` (create, move, cancel, errors, keyboard and 375 px, through the real UI),
`e2e/logout.spec.ts` (signing out ends the shared session, so it must come after the specs that use it),
`e2e/pwa.spec.ts`.
`e2e/appointments.spec.ts` arranges its data through the API at hours and days the other specs do not use,
and blocks the service worker so `page.route` can reliably fake server errors.

Global setup creates two uniquely named owners (A and B, each with its own
business) with the auth CLI
(`docker compose exec -T api node apps/api/src/auth-cli.ts ...`), signs each in
through the API and seeds A with two services and a few appointments around today
and B with a different set; global teardown deletes every row of both businesses
and users with SQL through `docker compose exec -T postgres psql`. If a run is
killed before teardown, the leftovers are the businesses named
`E2E Agenda <suffix>` / `E2E Otro <suffix>` and the users
`e2e-a-<suffix>@example.test` / `e2e-b-<suffix>@example.test`. Better Auth allows
3 sign-ins per 10 s, so the specs reuse one API session and only the form specs
sign in (they wait out a 429). Failure traces go to the system temp directory
(`gestion-e2e-results`), not into the repo. The browser timezone is fixed to `America/Bogota`.
`E2E_BASE_URL` overrides `http://localhost:8080`, and `POSTGRES_USER` /
`POSTGRES_DB` override the database credentials used by the teardown.

## WhatsApp bot

Customers book, list and cancel their appointments by chatting with the business's WhatsApp number (Cloud
API). The API receives Meta's webhook at `/api/whatsapp/webhook` and answers with a stateless menu bot
(reply buttons and lists). Code: `apps/api/src/whatsapp/`; the webhook payload schema is in
`packages/shared/src/whatsapp.ts`; the SQL is in `packages/db/src/whatsapp.ts`.

The integration is **off by default**: with `WHATSAPP_APP_SECRET` unset the webhook routes answer `404`
and the rest of the API is unaffected. It is built and tested with simulated traffic only; the steps
below connect the real WhatsApp account.

### Configuration

| Variable | Needed | Meaning |
|---|---|---|
| `WHATSAPP_APP_SECRET` | yes | App secret of the Meta app; signs every delivery (`X-Hub-Signature-256`) |
| `WHATSAPP_VERIFY_TOKEN` | yes | Any random string you choose; Meta sends it back in the subscription handshake |
| `WHATSAPP_TOKEN` | yes | Access token used to send messages (Bearer) |
| `WHATSAPP_PHONE_NUMBER_ID` | no | Default for `pnpm whatsapp:link`; the API itself routes by the id inside each delivery |
| `WHATSAPP_API_VERSION` | no | Graph API version, `v23.0` by default |
| `WHATSAPP_API_BASE_URL` | no | Graph API host, `https://graph.facebook.com` by default; only override it to point at a local stub |

The three required variables must be **all set or all unset**. If only some are set, the API refuses to
start and says which are missing (it never prints values). Empty values count as unset, so
`docker-compose.yml` passes all of them through with empty defaults (`${WHATSAPP_APP_SECRET:-}`, ...): it
holds no secret and no default. Put the real values in your shell or an untracked `.env` when starting the
stack, never in a tracked file.

### Connecting the real WhatsApp account (do this at the end)

1. In [developers.facebook.com](https://developers.facebook.com) create an app of type **Business** and add
   the **WhatsApp** product.
2. **WhatsApp > API Setup**: pick the sending number (Meta provides a test number; add recipients to its
   allow-list while testing) and copy its **Phone number ID** (digits).
3. Create the access token. The temporary one on the same page lasts 24 hours; for a permanent one create a
   System User in Business Settings, give it the app and the WhatsApp account, and generate a token with the
   `whatsapp_business_messaging` permission. This is `WHATSAPP_TOKEN`.
4. **App settings > Basic > App secret** (Show): this is `WHATSAPP_APP_SECRET`.
5. Invent a verify token, for example `openssl rand -hex 24`: this is `WHATSAPP_VERIFY_TOKEN`.
6. Start the stack with those three variables set (and a public **HTTPS** URL pointing at it; Meta does not call
   plain HTTP or self-signed certificates):
   ```bash
   WHATSAPP_APP_SECRET=... WHATSAPP_VERIFY_TOKEN=... WHATSAPP_TOKEN=... docker compose up -d
   ```
7. Register the number for your business (the owner must exist, see "Create the owner user"):
   ```bash
   pnpm whatsapp:link --email owner@example.com --phone-number-id <Phone number ID>
   # Docker stack: docker compose exec api node apps/api/src/whatsapp-link-cli.ts --email ... --phone-number-id ...
   ```
   From the host it needs `DATABASE_URL` exported (see "Local development"); `AUTH_EMAIL` and
   `WHATSAPP_PHONE_NUMBER_ID` work as fallbacks for the two options.
   It is idempotent (`WhatsApp number linked` / `WhatsApp number already linked`), and a number that belongs
   to another business is refused (exit 1). Messages for a number that is not registered are ignored.
8. **WhatsApp > Configuration > Webhook**: Callback URL `https://<host>/api/whatsapp/webhook`, Verify token = your
   `WHATSAPP_VERIFY_TOKEN`, then *Verify and save*. Then, under *Webhook fields*, **subscribe to `messages`**.
9. Add services and opening hours (the agenda API or the PWA), and send "hola" to the number from a phone.

Replies are sent inside the 24-hour customer-service window that each incoming message opens, so no message
template is needed; reminders are sent with approved templates, see "Reminders".

### Conversation

The bot keeps no state: the state travels in the ids of the buttons and list rows, and every id is parsed
and checked against the database on every step (a forged or stale id, another business's service, a past slot
or someone else's appointment is answered with "Esa opción ya no es válida." and the main menu; nothing changes).
The customer is identified only by the sender number (`from`); a customer sees and cancels only their own
appointments.

| Customer | Bot |
|---|---|
| any text (or an unknown id) | main menu: reply buttons **Agendar**, **Mis citas**, **Cancelar** |
| Agendar | list of active services (`svc:<id>`); with more than 10, 9 services plus a **Más servicios** row (`svcs:<offset>`) for the next page |
| a service | list of the next 7 days that have opening hours and free slots (`day:<service>:<date>`) |
| a day | list of free slots, 10 rows per page; with more, 9 slots plus **Más horarios** (`more:...`) |
| a slot | confirmation buttons **Confirmar** / **Otro horario** / **Menú** |
| Confirmar | the appointment is created and confirmed, with the menu again. If it is already the customer's own booking of that service at that time (a repeated confirmation, a stale button, a concurrent duplicate) the bot says "Ya tienes esa cita agendada" and creates nothing; if someone else took it, "Ese horario se acaba de ocupar" |
| Mis citas | the customer's upcoming booked appointments, 10 per page; with more, a **Ver más citas** button (`mine:<offset>`) shows the next page |
| Cancelar | list of the customer's upcoming appointments, 9 plus a **Más citas** row (`cmore:<offset>`) when there are more than 10, then **Sí, cancelar** / **No, volver** |

Slots come from `opening_hours` minus booked appointments, in the business timezone (`businesses.timezone`,
IANA name, `America/Bogota` by default), stepping by the service duration, never in the past, and computed
with `Intl.DateTimeFormat` (`apps/api/src/whatsapp/availability.ts`), so daylight-saving days have their real
length. The booking still goes through `createAppointment`: if someone took the slot meanwhile the
exclusion constraint rejects it and the customer gets "Ese horario se acaba de ocupar." with the slots again.
Paging offsets are plain numbers (at most 4 digits) validated like every other id: a stale offset starts the list over and a malformed one is refused. All reply ids stay far below WhatsApp's 200-character limit. Without active services, without opening hours or without free slots the bot says so. Not built:
payments, media, free-text understanding, human handoff. There is no limit on how many appointments one
number can book.

WhatsApp limits respected by the message builders (`apps/api/src/whatsapp/messages.ts`; longer text is cut with
an ellipsis `…`): button title 20 characters, at most 3 buttons, list row title 24, row description 72, list
button label 20, section title 24, at most 10 rows per list, header and footer 60, interactive body 1024, text
body 4096, reply ids 200 (rows) and 256 (buttons).

### What the webhook answers

- `GET /api/whatsapp/webhook`: the subscription handshake. With `hub.mode=subscribe` and the right
  `hub.verify_token` (constant-time comparison) it echoes `hub.challenge` as plain text; anything else is `403`.
- `POST /api/whatsapp/webhook`: the signature of the **raw body** (`X-Hub-Signature-256`, HMAC-SHA256 with the
  app secret, constant-time comparison, exactly 64 hex digits) is verified before anything is parsed. A
  missing or wrong signature is `401` and nothing is processed (so is any signature when `WHATSAPP_APP_SECRET` is empty; an empty `WHATSAPP_VERIFY_TOKEN` makes the handshake `403`, as a defense in depth if the routes are mounted without the startup checks). A body over 1 MB is `413`. A correctly signed
  body that is not JSON is `400`. Every other signed delivery is `200`, including status updates (delivery and
  read receipts), unsupported message types (images, audio, location, ...), messages from numbers that are not
  8 to 15 digits and messages for an unregistered `phone_number_id`: they are ignored.
- These two routes are not behind the session guard (Meta calls them); every other route still is.

### Idempotency and failed sends

Meta retries deliveries and can send duplicates. Each message id (`wamid`) is claimed in
`whatsapp_processed_messages` (primary key, `business_id`, `received_at`, `completed_at`) with one atomic
`INSERT ... ON CONFLICT DO UPDATE ... WHERE` **before** the message is handled, so a repeated or concurrent
delivery of the same `wamid` does nothing: one booking, one confirmation, however many copies arrive.

The marker is also a **lease** of 2 minutes. A marker is *completed* (`completed_at` set) once handling ended
without needing a retry. A completed marker is never taken over. A marker that is not completed and whose
`received_at` is older than the lease (the process died after claiming it, or the marker could not be released)
is taken over by the next delivery of that `wamid`, atomically and by exactly one caller; inside the lease that
delivery is a duplicate (`200`, nothing sent) because another one may still be in flight. So a crash or a failed
release delays the message until Meta's next retry instead of losing it.

If handling or sending the reply fails after the marker was claimed:

- **A booking or cancellation was already applied**: the marker is completed and the delivery is answered `200`,
  so a retry can never book or cancel twice. The customer does not get the confirmation message in that case
  (it is logged as an error); "Mis citas" shows the result.
- **Nothing had been changed and the send error is permanent** (the Graph API answered `4xx` other than `408` and
  `429`: an invalid or expired token `401`/`403`, a rejected body `400`, an unknown phone number id `404`): resending
  cannot help, so the marker is completed, an error line is logged (no token, no full phone number) and the
  delivery is answered `200`; Meta does not retry. The customer gets no reply until the cause is fixed (check the
  logs for `permanent send error`), and that message is not answered later.
- **Nothing had been changed and the error is transient** (network error, timeout, `5xx`, `408`, `429`, a database
  error): the marker is removed and the delivery is answered `503`, so Meta's retry reprocesses the message. If
  removing the marker fails it is tried twice more; if it still fails, the marker stays uncompleted and the
  lease lets Meta's retry after 2 minutes take over (the earlier retries inside the lease are answered `200`
  without a reply).

Completing a marker is retried the same way; if it still fails the marker stays uncompleted, so a delivery after
the lease can handle the message again (a repeated reply is possible; a repeated booking is not, because the bot
reports "Ya tienes esa cita agendada").

### Logs

Logs hold message ids, masked numbers (`***4567`) and error kinds. They never include tokens, secrets, message
bodies or full phone numbers. Rejected (unsigned or wrongly signed) deliveries are logged as a warning at most once a
minute, with a `suppressed` count of how many were held back since the previous line, so unauthenticated traffic
cannot flood the logs.

### Simulate traffic locally (signed curl)

Use a throwaway secret, never the real one. Send outgoing messages to a local stub instead of Meta by setting
`WHATSAPP_API_BASE_URL` (Docker Desktop reaches the host at `host.docker.internal`):

```bash
# 1. a stub that prints what the bot would send to WhatsApp
node -e 'require("http").createServer((q,s)=>{let b="";q.on("data",c=>b+=c).on("end",()=>{console.log(q.method,q.url,b);s.setHeader("content-type","application/json");s.end("{\"messages\":[{\"id\":\"wamid.stub\"}]}")})}).listen(9999)' &

# 2. the stack with throwaway values and the stub as Graph API
WHATSAPP_APP_SECRET=throwaway-secret WHATSAPP_VERIFY_TOKEN=throwaway-verify WHATSAPP_TOKEN=throwaway-token \
  WHATSAPP_API_BASE_URL=http://host.docker.internal:9999 docker compose up -d

# 3. a business with an owner (see "Create the owner user"), its number and some data
pnpm whatsapp:link --email owner@example.com --phone-number-id 123456789012345

# 4. the handshake
curl -s "http://localhost:8080/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=throwaway-verify&hub.challenge=12345"   # 12345

# 5. a signed message from a customer (wamid must be unique per message; the same wamid twice is ignored)
BODY='{"object":"whatsapp_business_account","entry":[{"id":"1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"phone_number_id":"123456789012345"},"messages":[{"from":"573001234567","id":"wamid.demo-1","type":"text","text":{"body":"hola"}}]}}]}]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac 'throwaway-secret' -hex | sed 's/^.* //')
curl -i -X POST http://localhost:8080/api/whatsapp/webhook \
  -H 'content-type: application/json' -H "X-Hub-Signature-256: sha256=$SIG" --data-binary "$BODY"   # 200, the stub prints the menu
```

To tap a button, send an `interactive` message instead of `text`:
`{"from":"573001234567","id":"wamid.demo-2","type":"interactive","interactive":{"type":"button_reply","button_reply":{"id":"menu:book","title":"Agendar"}}}`
(`list_reply` for list rows). Take the ids from the stub's output. A wrong or missing signature is `401`.
Afterwards restart the stack without the variables (`docker compose up -d`) and remove the test business
rows if you created any.

## Reminders

The API sends two WhatsApp **template** messages per appointment: a **confirmation** right after it is created
(from the PWA or from the bot) and a **reminder 24 hours before** it starts. Templates are needed because the
business starts these conversations outside the 24-hour customer-service window. A pg-boss worker running inside
the API process does the sending (code: `apps/api/src/reminders/`; SQL: `packages/db/src/reminders.ts`).

**Status of verification: built and tested with a fake WhatsApp client and simulated time only. Real delivery was
not verified against Meta**: template approval, the Graph API answer shape and the category/pricing Meta
applies still have to be checked with the real account.

### Enabling it

| Variable | Needed | Meaning |
|---|---|---|
| `WHATSAPP_TEMPLATE_CONFIRMATION` | for reminders | Name of the approved confirmation template, e.g. `cita_confirmacion` |
| `WHATSAPP_TEMPLATE_REMINDER` | for reminders | Name of the approved 24-hour reminder template, e.g. `cita_recordatorio` |
| `WHATSAPP_TEMPLATE_LANGUAGE` | no | Language code of both templates, `es` by default (`es_CO`, `en_US`, ...) |

Reminders are **on only when WhatsApp is enabled (the three `WHATSAPP_*` variables) and both template names are
set**. Template names use lowercase letters, digits and underscores (what Meta allows). Setting exactly one
of the two names makes the API refuse to start and say which is missing (names only, never values). With reminders
off, nothing is scheduled or sent, appointments, the PWA and the bot work exactly as before, and no error is
raised; templates set without WhatsApp are ignored. `docker-compose.yml` passes the three variables with empty
defaults. At start the API logs `Reminders enabled` or `Reminders disabled`; if the pg-boss worker cannot start
(for example the database user may not create the `pgboss` schema) the API exits with an error instead of
running without reminders.

### Creating the two templates in Meta

In [Meta Business Manager](https://business.facebook.com) open **WhatsApp Manager > Account tools > Message
templates > Create template** (the same WhatsApp Business account as the sending number; menu names may differ slightly in Meta's current UI), and create both:

| Field | Confirmation | Reminder |
|---|---|---|
| **Category** | **Utility** (not Marketing, not Authentication) | **Utility** |
| **Name** | the value of `WHATSAPP_TEMPLATE_CONFIRMATION`, e.g. `cita_confirmacion` | the value of `WHATSAPP_TEMPLATE_REMINDER`, e.g. `cita_recordatorio` |
| **Language** | Spanish (`es`), or the code you put in `WHATSAPP_TEMPLATE_LANGUAGE` | same |
| **Header / footer / buttons** | none | none |
| **Body** | `Hola {{1}}, tu cita de {{2}} quedó confirmada para el {{3}} a las {{4}}.` | `Hola {{1}}, te recordamos tu cita de {{2}} mañana, {{3}} a las {{4}}.` |

Meta asks for an example value for each variable; use for instance `Ana`, `Corte`, `13/03/2031`, `09:00`. Submit
both and wait for the status **Approved**: only approved templates can be sent. The wording above is a
suggestion; keep the four variables `{{1}}` to `{{4}}`, in this order, because the API fills exactly these four
**body** parameters (text), in the business's timezone (`businesses.timezone`):

| Variable | Value | Example |
|---|---|---|
| `{{1}}` | customer name (`cliente` when the customer has none) | `Ana` |
| `{{2}}` | service name | `Corte` |
| `{{3}}` | appointment date, `dd/mm/yyyy` | `13/03/2031` |
| `{{4}}` | appointment time, `HH:mm` (24 h) | `09:00` |

Names and service names are collapsed to one line and cut at 60 characters. The request the API sends is the
Graph API `messages` call with `"type": "template"`, `template.name`, `template.language.code` and one `body`
component with those four text parameters. A template with a different number of variables, header variables or
buttons that need parameters is expected to be refused by Meta with a `4xx` (permanent, so the reminder is marked `failed`); this was not exercised against Meta.

### How it works

- **Table `appointment_reminders`** (migration `0005`) is the source of truth: one row per appointment and
  kind (`confirmation`, `reminder_24h`; unique together), `due_at`, `status` (`pending`, `sending`, `sent`,
  `failed`, `skipped`), `attempts`, `claimed_at` (the lease), `sent_at`, `whatsapp_message_id` and `last_error`
  (a short description such as `WhatsApp send failed with status 503`: never a phone number, name or token). It
  references the appointment with a composite key `(appointment_id, business_id)`, so a reminder cannot point at
  another business's appointment.
- **Scheduling.** `createAppointment` (shared by the agenda API and the bot) inserts the appointment and its
  reminders in one transaction: the confirmation due now and the 24-hour reminder due `starts_at - 24 h`; that
  one is left out when it would not be in the future (an appointment less than 24 h away gets only the
  confirmation), and an appointment already in the past gets none. Cancelling (PWA or bot) turns the **pending**
  reminders into `skipped`. Moving an appointment re-times only the 24-hour reminder (and skips it if its new
  time is already past, or creates it if the appointment is now far enough away); the confirmation is **not**
  sent again for the new time. A reminder already sent stays as it is.
- **Sweep.** A pg-boss schedule `reminders-sweep` runs every minute (pg-boss keeps its own tables in the
  `pgboss` schema of the same database; the first start creates it, so the database user needs `CREATE` on the
  database). A sweep claims due rows in one statement (`pending` -> `sending` with `claimed_at`, `FOR UPDATE SKIP
  LOCKED`) **before** calling WhatsApp, so concurrent sweeps (several API instances, overlapping runs) never send the
  same row. At send time it checks again that the appointment is still `booked` and in the future, the customer
  has a phone and the business has a row in `whatsapp_channels` (otherwise the reminder is `skipped` with the
  reason in `last_error`), then sends the template through the business's number.
- **Retries.** Transient failures (network error, timeout, `5xx`, `408`, `429`, the same classification as the
  webhook) put the row back to `pending` with a backoff of 1, 5 and 30 minutes, up to 4 attempts in total, then
  `failed`. Any other `4xx` (invalid token, rejected template, unknown number) is permanent: `failed` at once.
  Nothing retries a `failed` row; fix the cause and, if you still want to send it, set its status back to
  `pending` and `attempts` to `0` by hand.
- **Crashes.** A row left `sending` for more than 5 minutes (the process died mid-send) is claimed again by the
  next sweep, which counts as another attempt; a row that keeps dying is `failed` after the 4th. **Limit:** if the
  process dies *after* WhatsApp accepted the message but *before* the row was marked `sent`, the message is sent
  once more after the lease. Closing that gap would need an idempotency key that Meta honours; this implementation does not have one.
  A worker whose lease was taken over cannot overwrite the new owner's result.
- **Logs** carry reminder and appointment ids, the kind, the attempt and an error kind; never phone numbers,
  customer names or tokens.

Shutdown (`SIGTERM`/`SIGINT`) stops the worker gracefully (a running sweep gets 10 seconds) before the database
connection closes. Tests call the exported `sweepReminders` directly with a fake client and an injected clock;
one integration test starts pg-boss against the test database in a scratch schema.

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
| `whatsapp_channels` | WhatsApp `phone_number_id` (unique) of a business; routes webhook messages to it |
| `whatsapp_processed_messages` | one row per WhatsApp `wamid` (primary key): the webhook's idempotency marker and 2-minute lease (`completed_at` is set when handling finished) |
| `appointment_reminders` | confirmation and 24-hour reminder of each appointment: `kind`, `due_at`, `status`, `attempts`, lease and result (see "Reminders"); unique per appointment + kind |

An appointment can only reference a customer and a service of its own business:
`customers` and `services` are unique on `(id, business_id)`, and `appointments`
has composite foreign keys `(customer_id, business_id)` and `(service_id, business_id)`.
`appointments` is itself unique on `(id, business_id)` so that `appointment_reminders` can use the same pattern.

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
| `WHATSAPP_APP_SECRET` / `WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_TOKEN` | api | none (all three unset disables the WhatsApp webhook; some but not all refuses to start); empty in compose |
| `WHATSAPP_PHONE_NUMBER_ID` | api (informational), whatsapp:link CLI | none; empty in compose |
| `WHATSAPP_API_VERSION` / `WHATSAPP_API_BASE_URL` | api | `v23.0` / `https://graph.facebook.com`; empty in compose |
| `WHATSAPP_TEMPLATE_CONFIRMATION` / `WHATSAPP_TEMPLATE_REMINDER` | api | none (both unset, or WhatsApp disabled, turns reminders off; exactly one set refuses to start); empty in compose |
| `WHATSAPP_TEMPLATE_LANGUAGE` | api | `es`; empty in compose |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | compose | `gestion` |
| `POSTGRES_PORT` | compose (host port) | `5433` |

The compose defaults are for local development only. Set real values for any shared or public deployment.

## Scripts

| Command | What it does |
|---|---|
| `pnpm test` | Run all tests (the API tests need `docker compose up -d postgres`) |
| `pnpm typecheck` | Type-check every package |
| `pnpm build` | Build the web app (with the service worker and manifest) |
| `pnpm e2e` | Run the Playwright e2e tests against the Docker stack (`docker compose up -d --build` first; see "End-to-end tests") |
| `pnpm db:generate --name <name>` | Create a migration from `packages/db/src/schema.ts` |
| `pnpm db:migrate` | Apply migrations to `DATABASE_URL` |
| `pnpm auth:create-user --email <e> --password <p> --name <n> --business <b>` | Create the single owner (idempotent on email) |
| `pnpm whatsapp:link --email <e> --phone-number-id <id>` | Register a WhatsApp phone number id for the owner's business (idempotent; see "WhatsApp bot") |
