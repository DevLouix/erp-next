# Deployment strategies

This platform can be deployed in a few shapes. They differ mainly in **who owns
ports 80/443** (your reverse proxy) and **whether the Frappe Bench is bundled**.

All strategies share:

- A Truemoi OAuth app whose redirect URI is `${PUBLIC_BASE_URL}/auth/callback`.
- `PROVISIONING_BASE_DOMAIN` with wildcard DNS `*.<base>` pointing at the ingress.
- A **wildcard TLS certificate** for `*.<base>` — issued with a DNS-01 challenge
  (HTTP-01 cannot issue wildcards). The platform host can use a normal cert.
- The environment from [`.env.example`](../.env.example). `./deploy.sh` validates
  it and can generate secrets (see [Deploying with deploy.sh](../README.md#deploying-with-deploysh)).

| Strategy | Bench bundled? | Owns 80/443? | Best for |
| --- | --- | --- | --- |
| 1. Direct processes | no (uses existing Bench) | you provide | already running Frappe |
| 2. Single-host Docker Compose | yes | you provide (nginx/Caddy) | self-host, full stack |
| 3. Compose behind an existing proxy | yes | existing proxy | Traefik/nginx already present |
| 4. Dokploy | yes | Dokploy's Traefik | managed compose deploys |
| 5. Kubernetes / k3d | yes (not packaged) | cluster ingress | not provided yet |

## 1. Direct processes (control plane only, existing Bench)

Run the API and worker as processes against Postgres you already have.

- Install Node 20+ and pnpm; create the platform database and run
  `pnpm prisma:deploy`.
- Run the API (`pnpm start`) and the worker (`pnpm worker`) **on the Bench host**,
  so the worker can reach the Bench directory and MariaDB.
- You must provide the reverse proxy and wildcard TLS yourself.
- Choose this when a Frappe Bench already exists and you only want the control
  plane. Everything the worker needs is documented under `BENCH_*`, `MARIADB_*`.

## 2. Single-host Docker Compose (recommended for self-hosting)

`docker-compose.yml` brings up the whole product, including the Bench, and
**publishes host ports** (`PLATFORM_API_PORT`, `FRAPPE_HTTP_PORT`,
`PLATFORM_DB_PORT`).

```bash
cp .env.example .env
./deploy.sh              # or: docker compose up -d --build
```

- Put nginx or Caddy on 80/443, terminate TLS, and proxy `PUBLIC_HOST` →
  `127.0.0.1:3000` and `*.<base>` → `127.0.0.1:8080` (preserving the `Host`
  header). See the wildcard guidance in the main README.
- The test database `platform-postgres-test` is behind the `test` profile and is
  **not** started by default. Enable it when running integration tests:

  ```bash
  pnpm db:up                                        # starts platform-postgres + platform-postgres-test
  # or
  docker compose --profile test up -d platform-postgres-test
  ```
- Choose this when you control the host and have (or will install) a reverse
  proxy.

## 3. Compose behind an existing reverse proxy

If a proxy (Traefik or nginx) already owns 80/443, don't fight it for ports.

- **Traefik:** apply the overlay, which removes the host ports, joins the proxy's
  Docker network, and adds routers with a wildcard TLS certificate:

  ```bash
  docker compose -f docker-compose.yml -f docker-compose.dokploy.yml up -d
  ```

  The overlay is not Dokploy-specific — set `DOKPLOY_NETWORK` to your Traefik
  network and point `TRAEFIK_CERTRESOLVER` / `TRAEFIK_WILDCARD_CERTRESOLVER` at
  your resolvers. It needs Docker Compose ≥ 2.24 (the `!reset` tag) and a
  DNS-01 resolver in Traefik.
- **nginx (or any file-configured proxy):** keep the host ports (strategy 2) and
  add a vhost that proxies to `127.0.0.1:3000` / `127.0.0.1:8080`.

Do **not** both publish the ports and add proxy labels for the same service —
pick one edge. If the ports would conflict with the existing proxy, use the
overlay; otherwise strategy 2 is simpler.

## 4. Dokploy

Dokploy runs the Compose project and routes with its Traefik. See the
"Deploying on Dokploy" section in the main README. In short: use the **Docker
Compose** type, put the environment in Dokploy's UI, and load the overlay via
`COMPOSE_FILE=docker-compose.yml:docker-compose.dokploy.yml`. The overlay drops
host ports, joins `dokploy-network`, and requests one wildcard certificate via a
DNS-01 resolver.

## 5. Kubernetes / k3d

Not packaged today. If a k3d/k3s cluster already owns 80/443, you must either
deploy in-cluster (Deployments/Services/Ingress + cert-manager or Traefik DNS-01)
or free the ports (recreate the cluster without the 80/443 load-balancer mapping)
and use strategy 2. Ask if you want manifests scaffolded.

## Custom domains for tenant sites

Tenant custom domains require coordinated DNS ownership proof, a Frappe site
alias, a Dokploy/Traefik host route, and a certificate. The platform handles the
first two steps: an owner adds a domain to a ready instance, publishes its
per-domain TXT token, and verifies it. The worker then uses Bench's
`setup add-domain` command and probes Frappe with the custom Host header.
Unverified hostnames are not added to Frappe.

After the instance panel reports the Frappe alias is configured:

1. Point the custom hostname to the instance's assigned hostname: use a CNAME
   for a subdomain; for an apex/root domain, use the DNS provider's
   ALIAS/ANAME or CNAME-flattening feature, or point an A/AAAA record at the
   ingress.
2. In the Dokploy Compose app's **Domains** tab, add the hostname and select
   `frappe-frontend` on port `8080`. Enable HTTPS with a certificate resolver.
   Dokploy generates the Traefik route; keep the original Host header intact.
3. Test the exact `https://` hostname after DNS propagation and certificate
   issuance. The platform's `active` status confirms Frappe alias setup, not
   external proxy/TLS readiness.

Use a certificate valid for the custom hostname. The platform wildcard
certificate only covers its own `PROVISIONING_BASE_DOMAIN`. Traefik must be
reachable on port 80 for HTTP-01; use DNS-01 when that is unavailable or when
requesting a wildcard certificate. Persist Traefik's ACME storage and monitor
renewal errors. Dokploy routing and certificate lifecycle are managed in
Dokploy, not by the platform application.

For safe removal, first remove the custom host route from Dokploy and its DNS
record, then remove the domain in the instance panel. The worker removes the
Frappe alias; the platform blocks instance deletion while a custom hostname is
still attached. This avoids leaving an unassigned hostname routed to Frappe's
default site.

References: [Frappe Bench `add-domain`/`remove-domain`](https://github.com/frappe/bench/blob/develop/bench/commands/setup.py),
[Dokploy Compose domains](https://docs.dokploy.com/docs/core/docker-compose/domains),
[Traefik ACME](https://doc.traefik.io/traefik/reference/install-configuration/tls/certificate-resolvers/acme/).

## What the Dokploy overlay changes (and doesn't)

The base `docker-compose.yml` is the manual default and keeps host ports and the
optional test profile. `docker-compose.dokploy.yml` is an **overlay** applied on
top of it; on its own it does nothing. It:

- clears the published ports (`!reset []`) on `platform-api`,
  `frappe-frontend` and `platform-postgres`;
- adds the external edge network and Traefik labels with a wildcard TLS router.

Manual deployments are unaffected because they never load the overlay.
