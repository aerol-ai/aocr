#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILED=0

check_threshold() {
  local name="$1"
  local pct="$2"
  local threshold="${3:-90}"
  awk -v p="$pct" -v t="$threshold" -v n="$name" 'BEGIN {
    if (p + 0 < t + 0) {
      printf "FAIL %s coverage %.1f%% < %d%%\n", n, p, t
      exit 1
    }
    printf "OK   %s coverage %.1f%%\n", n, p
  }'
}

echo "==> auth"
(
  cd "$ROOT/auth"
  corepack enable >/dev/null 2>&1 || true
  pnpm install --frozen-lockfile >/dev/null
  pnpm run test:coverage
)

echo "==> hooks"
(
  cd "$ROOT/hooks"
  npm install >/dev/null
  npm run test:coverage
)

echo "==> mirror"
(
  cd "$ROOT/mirror"
  go test ./... -coverprofile=coverage.out -covermode=atomic
  pct="$(go tool cover -func=coverage.out | awk '/^total:/ { sub(/%/, "", $3); print $3 }')"
  check_threshold "mirror" "$pct" 74
)

echo "All package coverage checks passed."
