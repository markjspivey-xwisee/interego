#!/bin/sh
# Boot the CSS-on-PGSL server. Runtime env:
#   PGSL_PG_CONNSTR  Postgres connection string (read by PgslDataAccessorFactory)
#   CSS_BASE_URL     public base URL of this server (Solid needs the canonical URL)
#   PORT             listen port (default 3000)
set -eu

PORT="${PORT:-3000}"
BASE_URL="${CSS_BASE_URL:-http://localhost:${PORT}/}"

if [ -z "${PGSL_PG_CONNSTR:-}" ]; then
  echo "FATAL: PGSL_PG_CONNSTR is not set (Postgres connection string required)" >&2
  exit 1
fi

echo "Starting CSS-on-PGSL on port ${PORT}, baseUrl ${BASE_URL}"
exec npx --no-install community-solid-server \
  -c config/pgsl-server.json \
  -m . \
  -p "${PORT}" \
  -b "${BASE_URL}" \
  -l info
