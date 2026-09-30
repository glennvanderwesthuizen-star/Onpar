# syntax=docker/dockerfile:1
# On Par server package: one build, two images (the API and the website).
# The optional "ca" build secret is only for build machines behind an inspecting proxy.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN --mount=type=secret,id=ca,required=false sh -c '[ -s /run/secrets/ca ] && export NODE_EXTRA_CA_CERTS=/run/secrets/ca; pnpm install --frozen-lockfile'
RUN pnpm --filter @onpar/rules build && pnpm --filter @onpar/api build
# The website forwards /api to the API container inside the private network.
ENV API_URL=http://api:4000
RUN pnpm --filter @onpar/web build
RUN --mount=type=secret,id=ca,required=false sh -c '[ -s /run/secrets/ca ] && export NODE_EXTRA_CA_CERTS=/run/secrets/ca; pnpm --filter @onpar/api deploy --legacy --prod --prefer-offline /out/api'

# The API: runs any new database migrations, then starts.
FROM node:22-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out/api /app
# The folder for photos and certificates must belong to the app's user; a new Docker
# volume takes its owner from here.
RUN mkdir -p /data/uploads && chown node:node /data/uploads
USER node
EXPOSE 4000
CMD ["sh", "-c", "node dist/db/migrate-cli.js && node dist/main.js"]

# The management website.
FROM node:22-alpine AS web
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

# Tools for backups: the database client and openssl.
FROM postgres:16-alpine AS tools
RUN --mount=type=secret,id=ca,required=false sh -c 'set -e; if [ -s /run/secrets/ca ]; then cp /etc/ssl/certs/ca-certificates.crt /tmp/ca.bak; cat /run/secrets/ca >> /etc/ssl/certs/ca-certificates.crt; fi; apk add --no-cache bash openssl coreutils; if [ -f /tmp/ca.bak ]; then mv /tmp/ca.bak /etc/ssl/certs/ca-certificates.crt; fi'
COPY scripts/backup.sh scripts/restore.sh /scripts/
