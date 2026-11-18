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
creates no duplicate. Every option also falls back to an env var, so
`AUTH_EMAIL`, `AUTH_PASSWORD`, `AUTH_NAME` and `BUSINESS_NAME` work too.

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
