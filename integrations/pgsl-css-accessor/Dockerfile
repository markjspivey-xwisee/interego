# CSS-on-PGSL deployable (foundation-first Stage 5).
#
# A Community Solid Server whose storage backend is the PGSL lattice over managed
# PostgreSQL. Build context is a deployment-shaped tree (assembled by the deploy
# script) containing ONLY:
#   packages/pgsl-store/dist            (built lattice store; no @interego runtime deps on the accessor path)
#   packages/pgsl-store/package.json
#   integrations/pgsl-css-accessor      (accessor + factory + Components.js config)
# This clean tree avoids the monorepo-root componentsjs@6 (via @comunica) that is
# incompatible with CSS 7.1.9's componentsjs@5.
#
# Runtime config: PGSL_PG_CONNSTR (Postgres), CSS_BASE_URL (public URL), PORT.

# ---- build stage: full deps, compile TS, generate Components.js descriptor ----
FROM node:20 AS build
WORKDIR /app
COPY packages/pgsl-store/dist ./packages/pgsl-store/dist
COPY packages/pgsl-store/package.json ./packages/pgsl-store/package.json
COPY integrations/pgsl-css-accessor ./integrations/pgsl-css-accessor
# pg is a runtime dep of pgsl-store's pg-store.js (dynamic import). Install it at
# the tree ROOT so Node resolves it from packages/pgsl-store/dist/*.js (which walk
# up to /app/node_modules). Installing it in the accessor subtree would NOT be
# visible to pg-store.js (a different subtree).
RUN echo '{"name":"pgsl-deploy-root","private":true}' > package.json \
 && npm install --no-save pg@8
WORKDIR /app/integrations/pgsl-css-accessor
RUN npm install \
 && npm run build \
 # build-time-only deps must NOT survive into runtime: componentsjs-generator
 # brings a newer @comunica/componentsjs that collides with CSS's at load time.
 && rm -rf node_modules/componentsjs-generator node_modules/typescript node_modules/tsx

# ---- runtime stage: pruned tree, run CSS via its CLI (no tsx/typescript) ----
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/integrations/pgsl-css-accessor
COPY integrations/pgsl-css-accessor/docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
