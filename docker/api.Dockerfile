# Platform API + dashboard.
FROM node:22-bookworm-slim

# Prisma needs OpenSSL; ca-certificates for TLS to the identity provider.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10 --activate || npm install -g pnpm@10

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile && pnpm prisma generate

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000

# Apply migrations before serving so a fresh database is always ready.
CMD ["sh", "-c", "pnpm prisma:deploy && pnpm start"]
