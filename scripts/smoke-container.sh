#!/usr/bin/env bash
# Smoke-tests a built container image: hardened runtime, persistence across restarts,
# the shared end-to-end checks, and admin-token sign-in.
# Usage: scripts/smoke-container.sh IMAGE   (needs Docker, curl, and Node.js 22+)
set -euo pipefail
image="${1:?usage: smoke-container.sh IMAGE}"
name="paste-smoke-$$"
volume="paste-smoke-$$"
port="${SMOKE_PORT:-18080}"
base="http://127.0.0.1:${port}"
token="$(openssl rand -hex 32)"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; docker volume rm "$volume" >/dev/null 2>&1 || true; }
trap cleanup EXIT

start() {
  docker run -d --name "$name" -p "127.0.0.1:${port}:8080" --read-only --cap-drop ALL \
    --security-opt no-new-privileges -e PASTE_ADMIN_TOKEN="$token" -v "$volume:/var/lib/paste" "$image" >/dev/null
  for _ in $(seq 1 30); do
    curl -fsS "$base/healthz" >/dev/null 2>&1 && return 0
    sleep 1
  done
  docker logs "$name"
  echo "Container did not become healthy" >&2
  exit 1
}

start
node "$(dirname "$0")/../cloudflare/scripts/smoke.mjs" "$base"

link="$(printf 'persisted across restarts' | curl -fsS --data-binary @- "$base/?ttl=600")"
docker restart "$name" >/dev/null
for _ in $(seq 1 30); do curl -fsS "$base/healthz" >/dev/null 2>&1 && break; sleep 1; done
test "$(curl -fsS "$base/raw/${link##*/}")" = "persisted across restarts"
echo "Passed: paste persisted across a container restart."

test "$(curl -s -o /dev/null -w '%{http_code}' "$base/admin/api/pastes")" = 403
test "$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $base" --data-urlencode "token=wrong" "$base/admin/login")" = 401
cookie="$(curl -s -D - -o /dev/null -H "Origin: $base" --data-urlencode "token=$token" "$base/admin/login" | tr -d '\r' | sed -n 's/^[Ss]et-[Cc]ookie: \(paste_admin=[^;]*\).*/\1/p')"
test -n "$cookie"
curl -fsS -H "Cookie: $cookie" "$base/admin/api/pastes" | grep -q "\"${link##*/}\""
curl -fsS -H "Authorization: Bearer $token" "$base/admin/api/stats" >/dev/null
echo "Passed: admin token sign-in, session cookie, and bearer access."
