#!/usr/bin/env bash
# Build the pgvector artifact for the current platform and stage it under
# prebuilt/<platform>/.
#
# embedded-postgres ships PostgreSQL 18.x with NO pg_config and NO server
# headers, so pgvector cannot be compiled against it directly. Instead we build
# against a separately-installed PostgreSQL of the SAME MAJOR version (18.x) and
# rely on the extension ABI being stable within a major — a library built
# against any 18.x loads into embedded-postgres's 18.x. (Validated locally:
# Homebrew PG 18.1's vector.dylib loaded into embedded-postgres PG 18.3.)
#
# Requirements (provided per CI matrix cell):
#   - pg_config for PostgreSQL 18 on PATH, or PG_CONFIG pointing at it
#   - a C toolchain (make + cc)
#
# Usage:
#   PGVECTOR_VERSION=v0.8.1 packages/pgvector-embedded/scripts/build.sh
set -euo pipefail

PGVECTOR_VERSION="${PGVECTOR_VERSION:-v0.8.1}"
PG_CONFIG="${PG_CONFIG:-pg_config}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Platform key must match embedded-postgres's package suffix and Node's
# process.platform-process.arch (darwin-arm64, darwin-x64, linux-x64, linux-arm64).
node_platform() { node -e 'process.stdout.write(`${process.platform}-${process.arch}`)'; }
PLATFORM="${PLATFORM:-$(node_platform)}"
OUT_DIR="${PKG_ROOT}/prebuilt/${PLATFORM}"

PG_MAJOR="$("${PG_CONFIG}" --version | sed -E 's/^PostgreSQL ([0-9]+).*/\1/')"
if [[ "${PG_MAJOR}" != "18" ]]; then
  echo "ERROR: pg_config reports PostgreSQL ${PG_MAJOR}, expected 18 (embedded-postgres major). Set PG_CONFIG." >&2
  exit 1
fi

echo "==> pgvector ${PGVECTOR_VERSION} for ${PLATFORM} against $(${PG_CONFIG} --version)"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
git clone --depth 1 --branch "${PGVECTOR_VERSION}" https://github.com/pgvector/pgvector.git "${WORK}/pgvector"

make -C "${WORK}/pgvector" PG_CONFIG="${PG_CONFIG}"

PKGLIBDIR="$(${PG_CONFIG} --pkglibdir)"
SHAREDIR="$(${PG_CONFIG} --sharedir)"

rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}"

# Compiled extension library — name differs per platform ($(DLSUFFIX)).
cp "${WORK}/pgvector/vector"*.so "${OUT_DIR}/" 2>/dev/null || true
cp "${WORK}/pgvector/vector"*.dylib "${OUT_DIR}/" 2>/dev/null || true
# Fall back to the installed copy if the build dir naming differs.
if ! ls "${OUT_DIR}"/vector.* >/dev/null 2>&1; then
  cp "${PKGLIBDIR}/vector".* "${OUT_DIR}/"
fi

# Control + the full-install SQL for the pinned version only. CREATE EXTENSION
# at default_version reads vector--<version>.sql directly; the vector--A--B.sql
# upgrade scripts are only for ALTER EXTENSION ... UPDATE, which never runs on a
# fresh embedded DB, so we don't ship them.
PGVECTOR_SQL_VERSION="${PGVECTOR_VERSION#v}"
cp "${SHAREDIR}/extension/vector.control" "${OUT_DIR}/"
cp "${SHAREDIR}/extension/vector--${PGVECTOR_SQL_VERSION}.sql" "${OUT_DIR}/"

echo "==> staged $(ls "${OUT_DIR}" | wc -l | tr -d ' ') files in ${OUT_DIR}"
ls -1 "${OUT_DIR}" | sed 's/^/    /'
