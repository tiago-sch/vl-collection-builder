# Multi-stage build (plan §7).
#
# node:sqlite is built in, so there is no native addon: no python3/make/g++ in
# the builder and no architecture-specific binary in the runtime image.

# ---------------------------------------------------------------------------
# The build stage runs natively on the BUILDER's architecture, not the target's.
#
# That is only safe because there are no native addons: node:sqlite is built in,
# and every runtime dependency (fastify, cheerio, yauzl) is pure JavaScript, so
# the compiled output and the pruned node_modules are architecture-independent.
# `npm prune --omit=dev` removes the one exception — esbuild/vite ship platform
# binaries, and they are build-time only.
#
# The payoff is that a linux/arm64 image (Synology, Raspberry Pi) does not have
# to run npm and tsc under QEMU emulation, which turns minutes into seconds.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
WORKDIR /app

# Manifests first so `npm ci` is cached independently of source changes.
COPY package.json package-lock.json* ./
COPY packages/shared/package.json  packages/shared/package.json
COPY packages/server/package.json  packages/server/package.json
COPY packages/web/package.json     packages/web/package.json
RUN npm ci

COPY tsconfig.base.json ./
COPY packages ./packages

RUN npm run build
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
WORKDIR /app

# chdman, from the MAME toolchain (~30-40 MB). It packs .bin/.cue and .iso into a
# single compressed .chd, typically 40-60% smaller with no data loss — for a PS2
# or PS1 library that is the difference between 400 GB and roughly 200. Given
# that, the image cost is not a close call (plan §9.5b).
RUN apt-get update \
 && apt-get install -y --no-install-recommends mame-tools \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/data/vault.db \
    DOWNLOADS_PATH=/downloads \
    LIBRARY_PATH=/library \
    WEB_ROOT=/app/packages/web/dist

COPY --from=build /app/node_modules              ./node_modules
COPY --from=build /app/package.json              ./package.json
COPY --from=build /app/packages/shared/dist      ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/server/dist      ./packages/server/dist
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/web/dist         ./packages/web/dist

# Owned by `node` (uid 1000) for the default case, but also group- and
# world-writable so the image still works when the operator sets `user:` to
# match a NAS share with a different uid. A named volume inherits these
# permissions on creation, and without them /data is unwritable for any uid
# other than 1000 — which surfaces as an opaque SQLite error at boot.
# Host permissions still govern anything bind-mounted over these paths.
RUN mkdir -p /data /downloads /library \
 && chown -R node:node /data /downloads /library /app \
 && chmod 0777 /data /downloads /library
USER node

VOLUME ["/data", "/downloads", "/library"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]
