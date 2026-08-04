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

# Locker selection: REDIS_ADDR set -> shared Redis locker; otherwise the
# process-local memory locker (also used by CI/local tests).
#
# BOTH branches are single-replica today, and the Redis branch is NOT a licence
# to scale out: RedisLocker.clearLocks() does KEYS <prefix>* + DEL over the whole
# shared namespace on every boot AND every shutdown, so a second replica deletes
# the first one's live locks. See config/pgsl-server-redis.json.
#
# NOT a redis:// URL, whatever the old comment here said: the shipped
# RedisLocker.createRedisClient matches /^(?:([^:]+):)?(\d{4,5})$/ and THROWS on
# anything else, so the value must be host:port (redis.railway.internal:6379).
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
