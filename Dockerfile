# ---------------------------------------------------------------------------
# Base image pin.
#
# Node major 22 is retained deliberately: it is Maintenance LTS with support into
# April 2027. Changing majors during a hardening phase would introduce an
# uncontrolled variable into a build that also depends on musl-linked Prisma query
# engines and Next's native toolchain. A Node 24 move belongs in its own change,
# gated by the test suite.
#
# Pinned to an exact patch AND digest rather than the floating `node:22-alpine`,
# so a rebuild months from now produces the same base. The digest is what makes
# it deterministic; the human-readable tag is kept alongside so the pin can be
# reviewed and updated by a person.
#
# EVERY stage shares this base. The generated Prisma client carries a musl-linked
# libquery_engine, so builder and runner must not diverge on libc.
# ---------------------------------------------------------------------------
ARG NODE_IMAGE=node:22.23.0-alpine3.24@sha256:ab07539e0988b63558ff621f5fbe1077054c39d9809112974fb79993949d41cd


# --------------------------- deps: full install ----------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app

# Copied before the source so this layer caches on lockfile changes only.
COPY package.json package-lock.json ./
RUN npm ci


# --------------------------- builder: compile ------------------------------
FROM ${NODE_IMAGE} AS builder
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY next.config.ts tsconfig.json postcss.config.mjs ./
COPY public ./public
COPY src ./src

# Publishable by design and inlined into the client bundle at build time. The
# Phase 3A gate in next.config.ts fails this build if it is missing or blank,
# rather than shipping an empty key. Clerk SECRET keys are never build args:
# they are runtime environment only, and a build arg would persist in a layer.
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}

# npm ci runs @prisma/client's install script against an empty schema, producing a
# throwing stub. This explicit generate is what makes the client real.
RUN npx prisma generate
RUN npm run build


# --------------------------- runner: serves traffic ------------------------
# Contains no Prisma CLI, no TypeScript, no ESLint, no Vitest, no devDependencies,
# no test source, and no application source beyond what Next traced into the
# standalone output.
FROM ${NODE_IMAGE} AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# `node` (uid 1000) already exists in the base image; no user is created and no
# broad chmod is used. Ownership is set at copy time so the runtime user can read
# everything it needs and Next can write its runtime cache.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

USER node

EXPOSE 3000

# Liveness only. /ready must never drive Docker restart decisions: a brief database
# blip would make Docker kill an otherwise healthy application. Uses Node's built-in
# fetch, so no curl or wget is added to the image for this.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form: node is PID 1 and receives SIGTERM directly. No shell wrapper.
CMD ["node", "server.js"]


# --------------------------- migrator: one-shot ----------------------------
# A SEPARATE image whose only job is `prisma migrate deploy`. Keeping it separate
# is what allows the serving image to contain no Prisma CLI — which is where all
# three high-severity deepmerge-ts advisories live.
#
# It never serves traffic and is never coupled to application startup: the deploy
# sequence runs it and inspects its exit status before starting the new app.
FROM ${NODE_IMAGE} AS migrator
WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY prisma ./prisma

USER node

# Exits 0 when migrations apply or nothing is pending; non-zero on failure.
CMD ["npx", "prisma", "migrate", "deploy"]
