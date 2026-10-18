#!/bin/sh
# Re-vendors the Behnam Bagheri Design System (ds/v1 from github.com/behnambagheri/bea.sh)
# into static/ds/. The copy is served from this site so the Iran mirror (paste.behnam.pro)
# keeps its look when bea.sh is unreachable. Never edit the vendored files; put site rules in
# static/style.css or send changes upstream to bea.sh.
#
# Usage: scripts/sync-ds.sh [git ref]   (default: main)
set -eu

ref="${1:-main}"
repo="https://github.com/behnambagheri/bea.sh.git"
root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/static/ds"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git clone --quiet --depth 1 --branch "$ref" "$repo" "$work/bea.sh"
commit="$(git -C "$work/bea.sh" rev-parse HEAD)"

rm -rf "$dest/v1"
mkdir -p "$dest"
cp -R "$work/bea.sh/ds/v1" "$dest/v1"
# The brand mark is bea.sh's favicon; it is not part of ds/v1 yet.
cp "$work/bea.sh/favicon.svg" "$dest/mark.svg"
printf 'source: %s\nref: %s\ncommit: %s\n' "$repo" "$ref" "$commit" > "$dest/VERSION"

echo "Vendored ds/v1 from bea.sh $commit into static/ds/. Rebuild with: cd cloudflare && npm run build"
