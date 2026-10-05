#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(cat "${ROOT}/VERSION")"
[[ "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Invalid release VERSION." >&2; exit 2; }
RELEASE_NAME="Perseus-prototype-${VERSION}"
OUTPUT="${1:-${ROOT}/../dist/${RELEASE_NAME}.zip}"

for command in rsync zip; do
  command -v "${command}" >/dev/null 2>&1 || {
    echo "Missing required command: ${command}" >&2
    exit 2
  }
done

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/perseus-release.XXXXXX")"
DEST="${STAGE}/${RELEASE_NAME}"
cleanup() { rm -rf "${STAGE}"; }
trap cleanup EXIT INT TERM

mkdir -p "${DEST}"
for file in LICENSE README.md SECURITY.md THIRD_PARTY_NOTICES.md VERSION perseus perseus.env.example CONTEXT-0.9.md; do
  cp -p "${ROOT}/${file}" "${DEST}/${file}"
done
for file in "${ROOT}"/*.test.ts "${ROOT}"/*.test.mjs; do
  [[ -f "${file}" ]] && cp -p "${file}" "${DEST}/"
done

# Keep provider adapters, complete documentation, and regression sources.
# Exclude installed dependencies, credentials, and local runtime artifacts.
for directory in scripts docs extensions adapters harness; do
  mkdir -p "${DEST}/${directory}"
  rsync -a \
    --exclude='node_modules/' --exclude='dist/' --exclude='coverage/' \
    --exclude='.git/' --exclude='__pycache__/' --exclude='*.pyc' \
    --exclude='.DS_Store' --exclude='.env' --exclude='.env.*' \
    --exclude='auth.json' --exclude='credentials.json' \
    --exclude='sessions/' --exclude='*.jsonl' --exclude='*.log' \
    "${ROOT}/${directory}/" "${DEST}/${directory}/"
done

if grep -R -E -l 'sk-[A-Za-z0-9_-]{20,}' "${DEST}" >/dev/null 2>&1; then
  echo "Release rejected: credential-like content found." >&2
  exit 1
fi

mkdir -p "$(dirname "${OUTPUT}")"
OUTPUT="$(cd "$(dirname "${OUTPUT}")" && pwd)/$(basename "${OUTPUT}")"
ARCHIVE_TMP="${STAGE}/${RELEASE_NAME}.zip"
(
  cd "${STAGE}"
  zip -X -q -r "${ARCHIVE_TMP}" "${RELEASE_NAME}"
)
mv -f "${ARCHIVE_TMP}" "${OUTPUT}"
printf '%s\n' "${OUTPUT}"
