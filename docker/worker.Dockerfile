# Provisioning worker.
#
# Built on the SAME ERPNext image as the Bench so the worker has `bench`, the
# site directories and the shared `sites` volume — it is the component that
# talks to the Bench. Pin ERPNEXT_VERSION to the version your deployment uses.
ARG ERPNEXT_VERSION=v16.51.1
FROM frappe/erpnext:${ERPNEXT_VERSION}

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && (corepack enable && corepack prepare pnpm@10 --activate || npm install -g pnpm@10)

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile --prod=false && pnpm prisma generate

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
# Drop back to the unprivileged Frappe user, which owns the sites volume.
USER frappe
CMD ["./node_modules/.bin/tsx", "src/worker-entry.ts"]
