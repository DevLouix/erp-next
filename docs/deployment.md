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

The Dokploy deployment automates tenant routing without the Dokploy API by
using Traefik's file provider. The platform worker writes one exact-host router
configuration into a shared Docker volume; Traefik watches that directory and
routes only verified hostnames to the fixed `frappe-frontend:8080` upstream.
The route uses the configured ACME resolver for HTTPS. There is no catch-all
tenant router and no Docker socket access for the platform.

### One-time Dokploy Traefik setup

The Compose overlay creates the named Docker volume
`erpnext-custom-domain-routes` and mounts it into `platform-worker` at
`/var/lib/erpnext/custom-domain-routes`. Configure the Dokploy Traefik service
once to mount the same volume read-only and watch the mount as a file-provider
directory. For example, add this volume to Traefik's service:

```yaml
services:
  traefik:
    volumes:
      - erpnext-custom-domain-routes:/etc/traefik/dynamic/custom-domains:ro

volumes:
  erpnext-custom-domain-routes:
    external: true
    name: erpnext-custom-domain-routes
```

Enable the file provider in Traefik's **static** configuration (not inside the
dynamic route files):

```yaml
providers:
  file:
    directory: /etc/traefik/dynamic/custom-domains
    watch: true
```

Merge these settings into the existing Traefik service/configuration; do not
replace its Docker provider, entrypoints, or existing routers. Restart Traefik
once after changing the static config and volume mount. In the platform
environment, set `CUSTOM_DOMAIN_INGRESS_MODE=traefik-file` and set
`CUSTOM_DOMAIN_CERT_RESOLVER` to the name of a configured Traefik ACME resolver.
The default `letsencrypt` is correct only if that resolver exists.

Keep Traefik's ACME storage persistent and reachable on ports 80/443. HTTP-01
works for a non-wildcard hostname when public port 80 reaches Traefik; a
configured DNS-01 resolver is also suitable. The worker publishes routers on
`web` and `websecure` by default; set `CUSTOM_DOMAIN_HTTP_ENTRYPOINT` and
`CUSTOM_DOMAIN_HTTPS_ENTRYPOINT` if your entrypoints use different names.
Ensure Traefik and `frappe-frontend` share the Dokploy network so the fixed
upstream URL `http://frappe-frontend:8080` resolves. The worker volume is
read/write; Traefik's mount must be read-only.
Use a single Traefik ACME writer unless certificate storage is provided by a
purpose-built shared certificate service; multiple Traefik replicas must not
race on one local ACME storage file.

### Tenant onboarding and removal

1. The owner adds a domain in the instance panel. The panel displays a
   per-domain TXT ownership proof and a CNAME target.
2. The owner adds both records in their DNS provider. A subdomain should use
   the displayed CNAME to the assigned instance hostname. For an apex/root
   domain, use the provider's ALIAS/ANAME/CNAME-flattening feature or an A/AAAA
   record matching the ingress IPs (look them up from the assigned hostname).
   Set the DNS record to DNS-only rather than proxying it through a CDN during
   verification; the platform checks it resolves to the same ingress as the
   assigned hostname. DNS automation for arbitrary customer zones requires
   each customer to delegate DNS access; this platform does not
   collect their DNS-provider credentials.
3. After records propagate, the owner verifies the TXT record. Only then does
   the worker run Bench's `setup add-domain`, health-check Frappe using the
   custom Host header, and publish the exact-host Traefik route. Traefik
   requests the HTTPS certificate automatically.
4. Once DNS and certificate issuance finish, the custom hostname serves the
   same Frappe site and its website/login pages. `active` means the Frappe alias
   and ingress route were installed; certificate issuance may take additional
   time.

To disconnect, use **Remove custom domain**. The worker removes the route first,
then removes the Frappe alias. Remove the hostname's DNS record after the panel
confirms removal. Instance deletion remains blocked while a custom domain is
attached.

The route directory is control-plane input: limit write access to the platform
worker and mount it read-only into Traefik. Do not make it writable by tenant
containers or expose the Traefik API publicly.

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
