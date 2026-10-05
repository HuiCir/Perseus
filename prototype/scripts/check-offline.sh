#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_HARNESS="$(bash "${ROOT}/scripts/prepare-harness-runtime.sh")"
CHECK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/perseus-offline.XXXXXX")"
cleanup() { rm -rf "${CHECK_ROOT}"; }
trap cleanup EXIT INT TERM

# Resolve module imports inside the external dependency cache. No dependency
# symlinks, user configuration, or test state are written into the release.
ln -s "${RUNTIME_HARNESS}" "${CHECK_ROOT}/harness"
ln -s "${ROOT}/scripts" "${CHECK_ROOT}/scripts"
cp "${ROOT}"/*.test.ts "${ROOT}"/*.test.mjs "${CHECK_ROOT}/"

"${ROOT}/perseus" --version
export PI_OFFLINE=1 PERSEUS_ENABLED=0
"${RUNTIME_HARNESS}/node_modules/.bin/tsx" --tsconfig "${RUNTIME_HARNESS}/tsconfig.json" \
  --test "${CHECK_ROOT}"/*.test.mjs "${CHECK_ROOT}"/*.test.ts
(cd "${RUNTIME_HARNESS}" && npm run check)
