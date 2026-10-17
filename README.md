# erp-next — ERPNext multi-tenant hosting platform

A small SaaS control plane that lets customers sign in with **Truemoi** and create
their own **ERPNext** sites on **one existing Frappe Bench deployment**. Sites are
provisioned with Frappe's built-in multitenancy: one shared application codebase,
one existing MariaDB server, and a separate database + site directory per customer.

```
Hosting platform (this repo)                 Existing Frappe Bench (unchanged)
├── Truemoi OAuth (@truemoi/sdk)             ├── shared ERPNext application code
├── Customer dashboard                       ├── existing MariaDB
├── Platform API (Fastify)                    │   ├── customer-a database
├── Platform DB (PostgreSQL/Prisma)          │   └── customer-b database
└── Provisioning worker  ───────────────►     └── sites/
                                                  ├── a.apps.example.com/
                                                  └── b.apps.example.com/
```

The platform database stores **metadata only** (accounts, ownership, provisioning
state). Customer ERPNext business data never leaves each site's own database.

The Bench can be one you already run, **or** you can bring up the whole stack —
Frappe/ERPNext Bench included — with the bundled `docker-compose.yml` (see
[One-command stack](#one-command-stack)). Only the queued platforms' metadata is
backed up here; each site's own ERPNext data stays in MariaDB.

## Why this shape

- **No per-customer infrastructure.** The worker only calls supported `bench`
  commands against the deployment that already exists.
- **No shell.** Every external command is run with `execFile(file, args[])` with
  `shell: false`; nothing from the browser is ever interpolated into a command.
- **Ownership is enforced server-side** on every instance route, and the
  authenticated session is the only source of identity (a frontend-supplied user
  id is ignored).
- **The job queue lives in PostgreSQL** (`SELECT … FOR UPDATE SKIP LOCKED`), so no
  extra Redis/queue service is required and restarts never lose provisioning work.

## Requirements

- Node.js 20+ (developed on Node 24) and pnpm, for running the platform directly.
- PostgreSQL 14+ (Docker Compose provided for local use).
- An existing Frappe Bench with ERPNext installed, reachable by the worker — **or**
  Docker + Docker Compose to run the Bench from this repo.
- A Truemoi OAuth application (client id/secret) with this platform's callback
  registered as a redirect URI.

## One-command stack

`docker-compose.yml` runs the **entire** product — the Frappe/ERPNext Bench and the
hosting platform — on one host:

```bash
cp .env.example .env          # fill in Truemoi creds + secrets
pnpm stack:up                 # docker compose up -d --build
# API + dashboard:  http://localhost:${PLATFORM_API_PORT:-3000}
# Frappe ingress:   http://localhost:${FRAPPE_HTTP_PORT:-8080}
```

Every published host port is driven by an env var (`PLATFORM_API_PORT`,
`PLATFORM_DB_PORT`, `FRAPPE_HTTP_PORT`, `PLATFORM_TEST_DB_PORT`), so the stack can
share a host with other containers without editing `docker-compose.yml`. The
in-container ports stay fixed, so service-to-service networking is unaffected;
remember to keep `PUBLIC_BASE_URL` (and `TEST_DATABASE_URL`) in sync with any
ports you change.

Services are namespaced: `platform-*` for the hosting platform, `frappe-*` for the
Bench. Under the pinned Compose project name (`COMPOSE_PROJECT_NAME`, default
`erpnext`) containers appear as `erpnext-platform-api-1`, `erpnext-frappe-db-1`, etc.

| Service | Role |
| --- | --- |
| `platform-api` | Fastify API + dashboard (also runs `prisma migrate deploy` on boot). |
| `platform-worker` | Provisioning worker. Built **from the ERPNext image** so it has `bench` and the shared `sites` volume. |
| `platform-postgres` | Platform metadata database. |
| `frappe-backend`, `frappe-frontend`, `frappe-websocket` | Frappe web/app/ingress (`frappe-frontend` publishes `8080`). |
| `frappe-db` | Shared MariaDB; each site gets its own database on it. |
| `frappe-queue-short`, `frappe-queue-long`, `frappe-scheduler` | Frappe background workers/scheduler. |
| `frappe-redis-cache`, `frappe-redis-queue` | Frappe cache and queue brokers. |
| `frappe-configurator`, `frappe-create-site` | One-shot: configure `common_site_config.json`, then create `BOOTSTRAP_SITE`. |
| `platform-postgres-test` | Test-only DB on host port `5433` (opt-in integration test). |

The Frappe services follow the upstream
[`frappe_docker`](https://github.com/frappe/frappe_docker) `pwd.yml`; pin
`ERPNEXT_VERSION` in `.env` to the version you deploy. The worker regenerates
nginx vhosts best-effort (`PROVISION_ROUTING_MODE=best-effort`) because nginx runs
as the separate `frappe-frontend` service and the **HTTP health check is the real
gate**.

### Deploying with `deploy.sh`

`deploy.sh` wraps the stack up with production guardrails. It checks Docker, then
checks that `.env` is production-ready (HTTPS `PUBLIC_BASE_URL`, a strong
`SESSION_COOKIE_SECRET`, non-placeholder DB/admin passwords, Truemoi settings and
a real `PROVISIONING_BASE_DOMAIN`). If values are missing it offers to
**auto-generate the secrets** and prompts you for the rest, then forces
`NODE_ENV=production` and `COOKIE_SECURE=true` before starting the services.

```bash
./deploy.sh                # interactive: fix missing values, confirm, deploy
./deploy.sh --auto         # auto-generate secrets, prompt only for the rest
./deploy.sh --auto -y      # non-interactive (fails if non-secret values are missing)
./deploy.sh --dry-run      # validate + print the plan; writes/starts nothing
./deploy.sh --force        # rotate all secrets
./deploy.sh --down         # stop the stack
```

| Flag | Effect |
| --- | --- |
| `-a`, `--auto` | Auto-generate secrets; prompt only for non-secret values. |
| `-y`, `--yes` | Skip the final confirmation. |
| `--force` | Regenerate all secrets (rotates credentials). |
| `--dry-run`, `--check` | Validate and print the plan; write/start nothing. |
| `--no-build` | Skip rebuilding images. |
| `--allow-insecure` | Permit an `http://` `PUBLIC_BASE_URL` (trusted staging only). |
| `--logs` | Follow `platform-api`/`platform-worker` logs after deploying. |
| `--down` | Stop the stack and exit. |

Generated secrets are written to `.env` (chmod `600`, gitignored). For a
confidential Truemoi client set `TRUEMOI_CLIENT_SECRET`; for a public client it can
stay empty.

## Quick start (run the platform directly)

```bash
cp .env.example .env          # then edit the values
pnpm install

# 1. Platform database
pnpm db:up                     # starts postgres + postgres-test
pnpm prisma:generate
pnpm prisma:deploy             # applies prisma/migrations

# 2. API + dashboard
pnpm dev                       # http://localhost:3000

# 3. Provisioning worker (usually a separate process / host)
pnpm worker
```

Then visit `http://localhost:3000`, click **Continue with Truemoi**, and create a
site from the dashboard.

## Environment variables

See [`.env.example`](./.env.example) for the full annotated list. The important
ones:

| Variable | Purpose |
| --- | --- |
| `PUBLIC_BASE_URL` | Public origin; OAuth redirect URI and CSRF origin check. |
| `DATABASE_URL` | PostgreSQL connection string for platform metadata. |
| `SESSION_COOKIE_SECRET` | ≥32 chars; reserved for signed-cookie use. |
| `TRUEMOI_CLIENT_ID` / `TRUEMOI_CLIENT_SECRET` | OAuth client. Secret only for confidential clients. |
| `TRUEMOI_AUTH_DOMAIN` / `TRUEMOI_API_URL` / `TRUEMOI_AUTH_REALM` | Truemoi endpoints (`@truemoi/sdk` config). |
| `TRUEMOI_ADMIN_ROLES` / `ADMIN_EMAILS` | Map Truemoi roles/emails to platform admins. |
| `PROVISIONING_BASE_DOMAIN` | Sites get `<slug>.<baseDomain>`; wildcard DNS required. |
| `BENCH_PATH` / `BENCH_BIN` | Bench directory and binary on the worker host. |
| `MARIADB_ROOT_PASSWORD` / `ERPNEXT_ADMIN_PASSWORD` | Used by `bench new-site`; never logged. |

## Authentication (Truemoi)

The platform uses the **authorization code flow with PKCE** via `@truemoi/sdk`
(v0.0.5). Server-side flow:

1. `GET /auth/login` → `TruemoiOAuth.beginLogin()` generates state, PKCE verifier
   and nonce, registers the transaction with Truemoi (`POST /api/auth/state`), and
   stores it in `oauth_transactions`; the browser is redirected to the provider.
2. `GET /auth/callback` consumes the transaction **once** (so replays fail), calls
   `exchangeCode(code, redirectUri, codeVerifier, state, clientSecret)`, then
   `getUserInfo(accessToken)`.
3. The user is upserted keyed on the stable OAuth **subject** (`oauth_subject`),
   a platform session is created (opaque random token; only its SHA-256 hash is
   stored in the DB), and an httpOnly, SameSite=Lax cookie is set.

Register the redirect URI `${PUBLIC_BASE_URL}/auth/callback` in Truemoi. There is
no password-based auth in the platform.

## Roles, admin control and RBAC

- Every user has a platform `role` (`user` or `admin`).
- On each login the role is resolved from the Truemoi `role` claim
  (`TRUEMOI_ADMIN_ROLES`) and the `ADMIN_EMAILS` allow-list. A role granted
  manually in the platform database is preserved unless Truemoi explicitly grants
  admin — so operator promotions stick, but a revoked Truemoi admin is demoted.
- Admins can: list all users/instances, retry a failed provisioning job, change a
  user's role, disable/enable a user (disabling revokes all their sessions
  immediately), and read the audit log.
- Users can only ever see and manage their own instances. Cross-customer access
  returns **404** (not 403) so instance existence is not disclosed.
- See `src/auth/roles.ts`, `src/auth/middleware.ts`, `src/admin/adminService.ts`.

## Instance lifecycle

States: `queued → provisioning → installing → configuring → ready`, or `failed`.

- `POST /api/instances` validates the name, derives a strict `[a-z0-9-]` slug and
  `<slug>.<baseDomain>` hostname, creates the instance as `queued`, and enqueues a
  job. No long work happens in the request.
- The worker claims one job atomically, then runs:
  `bench new-site` → `bench --site <s> install-app erpnext` (only if missing) →
  `bench --site <s> set-config host_name https://<hostname>` →
  `bench setup nginx` + `bench reload-nginx` (see `PROVISION_ROUTING_MODE`) →
  HTTPS health check (`/api/method/ping`). Only a passing health check marks the
  site `ready`.
- Failures record a **redacted** error, clean up the partial site, and retry with
  exponential backoff up to `PROVISION_MAX_ATTEMPTS`. Stale/locked jobs (worker
  crash) are recovered on the next loop. Duplicate requests are prevented by
  unique `site_name`/`hostname`, a per-owner `Idempotency-Key`, and one active job
  per instance.

## Reverse proxy, DNS and TLS

- Create a wildcard DNS record `*.${PROVISIONING_BASE_DOMAIN}` → the server that
  runs nginx/Frappe.
- The worker runs `bench setup nginx` (which writes a vhost per site) and reloads
  nginx after configuring the hostname.
- Terminate TLS with a wildcard certificate for `*.${PROVISIONING_BASE_DOMAIN}`
  at the existing reverse proxy (or via `bench setup lets-encrypt` if that matches
  your deployment). The platform itself should also be served over HTTPS in
  production; set `COOKIE_SECURE=true`.

## Backup, export and import

Platform state (users, instances, jobs, audit history) can be exported as a single
JSON snapshot and imported into any instance of this platform — for migration,
disaster recovery, or seeding. Sessions, OAuth transactions and tokens are
**deliberately excluded**, so imported users simply sign in again.

- **Dashboard:** an admin opens `/admin` and uses the backup panel to download a
  snapshot, save a named snapshot, or restore from a file (with a dry-run preview).
- **HTTP API** (admin only): `GET /api/admin/backup/export`,
  `POST /api/admin/backup`, `GET /api/admin/backup`,
  `GET /api/admin/backup/:id/download`, `DELETE /api/admin/backup/:id`, and
  `POST /api/admin/backup/import` (body: `{ "snapshot": … }` or a bare snapshot).
- **CLI** (portable, works against any database):

  ```bash
  pnpm backup:export ./platform-backup.json
  pnpm backup:import ./platform-backup.json --dry-run
  pnpm backup:import ./platform-backup.json --base-domain new.example.com
  ```

Import is a **merge** keyed on OAuth subject and site name: existing records are
updated, new ones created, nothing is deleted, and imported instances that are not
`ready` are re-queued so the worker reconciles them against the target Bench.
`--base-domain` rewrites every site hostname for a new domain. Treat snapshot
files as sensitive: they contain account emails and ownership.

## Where the worker runs

The worker needs filesystem access to the Bench directory, so run it **on the
Bench host** as a dedicated, least-privileged OS user (e.g. the Frappe user). If
the API runs elsewhere, the recommended split is: API + dashboard + PostgreSQL on
one host, worker on the Bench host, sharing the platform database. The bundled
compose stack does exactly this: `platform-worker` is a container built from the
ERPNext image and mounted on the shared `sites` volume, while `platform-api` only
needs PostgreSQL. Do not expose the Bench directory or privileged credentials to
customers.

## Security notes

- Ownership is checked on every instance API call; admins are the only exception.
- Site names/hostnames are restricted to a strict allow-list and reserved names
  (`www`, `api`, `admin`, …) are rejected.
- Database/administrator secrets are passed to `bench` as arguments, stripped from
  all stdout/stderr before logging, and never returned by the API.
- State-changing requests with a mismatched `Origin` are rejected (CSRF defence),
  and cookies are httpOnly + SameSite=Lax.
- **Isolation caveat:** separate databases and Frappe sites provide data separation
  and per-site access control, but they share one application process and one
  MariaDB server. This is **not** complete compute isolation. Customers cannot run
  arbitrary server commands or install arbitrary apps.

## API reference

All routes except `/auth/*` and `/login` require an authenticated session.

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/instances` | Create an instance. Body `{ "name": "Acme" }`; optional `Idempotency-Key` header. Returns `201 { instance }`. |
| `GET` | `/api/instances` | List the caller's instances (all, for admins). |
| `GET` | `/api/instances/:id` | Get one instance (ownership enforced). |
| `POST` | `/api/admin/instances/:id/retry` | Admin: re-queue a failed instance. |
| `GET` | `/api/admin/users` | Admin: list users. |
| `GET` | `/api/admin/instances` | Admin: list all instances. |
| `POST` | `/api/admin/users/:id/role` | Admin: `{ "role": "user" \| "admin" }`. |
| `POST` | `/api/admin/users/:id/disabled` | Admin: `{ "disabled": true \| false }`. |
| `GET` | `/api/admin/audit` | Admin: recent audit entries. |
| `GET` | `/api/admin/backup/export` | Admin: download a full JSON snapshot of platform state. |
| `POST` | `/api/admin/backup` | Admin: store a named snapshot in the platform DB. |
| `GET` | `/api/admin/backup` | Admin: list stored snapshots. |
| `GET` | `/api/admin/backup/:id/download` | Admin: download a stored snapshot. |
| `DELETE` | `/api/admin/backup/:id` | Admin: delete a stored snapshot. |
| `POST` | `/api/admin/backup/import` | Admin: merge a snapshot (`{ snapshot }` or bare); supports `dryRun`, `baseDomainOverride`. |

## Testing

```bash
pnpm test          # unit + HTTP tests against an in-memory store (no DB needed)
pnpm typecheck

# Optional: run the Prisma integration test against a real PostgreSQL
TEST_DATABASE_URL=postgresql://erpnext:erpnext@localhost:5433/erpnext_platform_test pnpm test
```

Covered by tests: OAuth state validation and replay rejection, session
protection, role resolution, cross-customer isolation, admin authorization,
duplicate-request/idempotency, name validation, the full provisioning happy path,
retry/backoff, exhausted-failure cleanup, secret redaction, command construction
(no shell interpolation), and backup export/import (admin-only, sessions/tokens
excluded, dry-run, idempotent merge, base-domain override).

## Deployment checklist

1. Provision PostgreSQL and run `pnpm prisma:deploy` (the compose `platform-api`
   does this automatically on boot).
2. Set all variables from `.env.example`; use real secrets and `NODE_ENV=production`.
3. Run the API behind TLS (`pnpm start` or `pnpm stack:up`, or your process manager).
4. Run `pnpm worker` on the Bench host (or the `platform-worker` container).
5. Ensure wildcard DNS + TLS for `*.${PROVISIONING_BASE_DOMAIN}`.
6. Register `${PUBLIC_BASE_URL}/auth/callback` in Truemoi and set an admin role/email.
7. Sign in, create a site, confirm it reaches `ready` and opens over HTTPS.
8. Take an initial `pnpm backup:export` and schedule periodic snapshots; test a
   `pnpm backup:import … --dry-run` restore on a spare instance.

## Out of scope (by design)

Billing/subscriptions, payments, multiple ERPNext servers or scheduling,
Kubernetes, dedicated infrastructure per customer, and analytics/metering.
