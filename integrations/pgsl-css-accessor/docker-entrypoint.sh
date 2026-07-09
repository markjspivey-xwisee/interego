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

# Locker selection: REDIS_ADDR set (a redis:// URL) -> shared Redis locker
# (safe multi-replica over the coherent Postgres backend); otherwise the
# process-local memory locker (single replica; also used by CI/local tests).
CONFIG=config/pgsl-server.json
if [ -n "${REDIS_ADDR:-}" ]; then
  CONFIG=config/pgsl-server-redis.json
  # Substitute the redis address into a writable copy of the config.
  sed "s|__REDIS_ADDR__|${REDIS_ADDR}|g" "$CONFIG" > /tmp/pgsl-server-active.json
  CONFIG=/tmp/pgsl-server-active.json
  echo "Locker: shared Redis (${REDIS_ADDR})"
else
  echo "Locker: process-local memory (single replica)"
fi

echo "Starting CSS-on-PGSL on port ${PORT}, baseUrl ${BASE_URL}, config ${CONFIG}"
exec npx --no-install community-solid-server \
  -c "${CONFIG}" \
  -m . \
  -p "${PORT}" \
  -b "${BASE_URL}" \
  -l info
