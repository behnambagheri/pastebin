# syntax=docker/dockerfile:1
# Container image for paste: the same code as the Cloudflare Worker, served by Node.js
# with SQLite storage and admin-token sign-in. The original Rust server is in Dockerfile.rust.

# Debian (glibc) for the build so the Worker test suite can run under workerd.
FROM --platform=$BUILDPLATFORM node:24-slim AS build
WORKDIR /build/cloudflare
COPY cloudflare/package.json cloudflare/package-lock.json ./
RUN npm ci
COPY static/ /build/static/
COPY cloudflare/ ./
RUN npm run build && npm test

FROM node:24-alpine
ARG BUILD_REVISION=development
ENV NODE_ENV=production BUILD_REVISION=$BUILD_REVISION \
    PASTE_LISTEN=:8080 PASTE_DATA_DIR=/var/lib/paste
RUN mkdir -p /app /var/lib/paste && chown 10001:10001 /var/lib/paste
COPY --from=build /build/cloudflare/dist/server.mjs /app/server.mjs
COPY LICENSE /usr/share/doc/paste/LICENSE
USER 10001:10001
WORKDIR /app
VOLUME ["/var/lib/paste"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["node", "/app/server.mjs"]
