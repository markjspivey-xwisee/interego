# Interego: Azure Container Apps → one self-hosted box

**Why:** your current Azure bill is ~$250/mo (low traffic) to ~$690/mo (busy),
dominated by 16 GiB of *always-on* memory. This stack fits comfortably on a
single small server for a flat **~$8–16/mo** (Hetzner CX32/CX42) — or **$0** on
Oracle Cloud Always Free if you build arm64 images. The PGSL re-platform already
did the hard part: CSS storage is now just Postgres, so **migrating all data is a
single `pg_dump`** — no file/volume copy.

---

## The one hard truth (read first)

The compose is the easy part. The real work is **URLs and identity**, because you
cannot take the `*.azurecontainerapps.io` hostnames with you:

1. **WebAuthn passkeys are cryptographically bound to the identity RP-ID**
   (`interego-identity.…azurecontainerapps.io`). Moving to `identity.$DOMAIN`
   invalidates them — **users must re-register their passkey once.** Unavoidable.
2. **WebIDs / `did:web`** live on the Azure hostnames (acme-id, gate pods).
   New host → new identifiers.
3. **Pod data is keyed under the CSS canonical base URL.** The dump is keyed
   under `https://interego-css.internal.…/`; the box uses a new canonical URL,
   so keys must be **re-based** (see step 5).
4. **Connectors (claude.ai, etc.) re-auth** when the relay's public URL changes —
   same one-time reconnect we just dealt with for the OAuth-client wipe.

Because passkeys reset no matter what, a **near-clean start on your own domain**
is the pragmatic path for a personal project; full byte-for-byte preservation
buys little once passkeys reset anyway. Both paths are below.

---

## 0. Prereqs
- A domain you control (`interego.xwisee.com`) with DNS you can edit.
- A box: **Hetzner CX32 (4 vCPU/8 GB, ~€8)** runs everything except a busy
  foxxi-bridge comfortably; **CX42 (8 vCPU/16 GB, ~€16)** matches your current
  always-on allocation 1:1. Ubuntu 24.04. Install Docker + compose plugin.
- `docker login contextgraphsacr.azurecr.io` on the box (username/password from
  `az acr credential show -n contextgraphsacr`) — or mirror images to GHCR
  (free) / add `build:` stanzas and build on-box.

## 1. Files
Copy this `deploy/self-host/` dir to the box. `cp .env.example .env` and fill it
in. **`.env` is git-ignored — never commit it.**

## 2. Secrets — copy from Azure (do NOT regenerate)
For each `[secret:…]` in ACA, copy the value into `.env`. The **★PIN★** ones are
load-bearing:
```bash
# list secret names per app; reveal a value:
az containerapp secret list -g context-graphs-rg -n interego-relay -o table
az containerapp secret show  -g context-graphs-rg -n interego-relay --secret-name relay-agent-key-json --query value -o tsv
```
- `RELAY_AGENT_KEY_JSON`, `RELAY_COMPLIANCE_WALLET_JSON`, `TOKEN_SIGNING_KEY` —
  regenerating these orphans every OAuth client + breaks token verification
  (this is the exact failure mode behind the `svc-relay-dcr` incident).
- `FOXXI_*_SEED` / `FOXXI_BRIDGE_PRIVATE_KEY` — derive stable DIDs/VCs; keep them.

## 3. Bring up data plane
```bash
docker compose up -d postgres redis
```

## 4. Migrate the database (the whole pod store, in one shot)
Everything CSS holds — user pods, the relay's `svc-relay-dcr` (OAuth clients +
tokens we just restored), ontologies — is in the `pgsl_prod` DB.
```bash
# temporarily allow your box's IP through the Azure PG firewall, then:
az postgres flexible-server firewall-rule create -g context-graphs-rg \
  -n interego-pgsl-db --rule-name box --start-ip-address <BOX_IP> --end-ip-address <BOX_IP>
pg_dump "host=interego-pgsl-db.postgres.database.azure.com user=iegoadmin dbname=pgsl_prod sslmode=require" -Fc -f pgsl_prod.dump
# restore into the box:
docker compose exec -T postgres pg_restore -U $POSTGRES_USER -d pgsl_prod --clean --if-exists < pgsl_prod.dump
# remove the firewall rule afterwards.
```

## 5. Re-base the CSS canonical URL (only if preserving data)
The restored resources are keyed under `https://interego-css.internal.…/`. The
box's CSS uses `CSS_BASE_URL` (default `http://css:3456/`). Two options:

- **Path A — near-clean start (recommended, simplest):** skip step 4's data (or
  keep only what you need). Set `CSS_BASE_URL=http://css:3456/`. Bring the stack
  up empty; the maintainer identity + agent pods **self-bootstrap on first use**
  (lazy-pod-init), passkeys re-register, connectors reconnect. Re-publish only
  the essentials you care about. Core `iep:` vocab is on GitHub Pages already, so
  the protocol surface is unaffected.
- **Path B — preserve everything:** keep the data from step 4 and re-base its
  keys to the box's canonical URL. Because PGSL keys are content-encoded (not a
  plain string column), re-base at the app layer: run a small script that lists
  every resource from the restored store and re-PUTs it under `http://css:3456/`
  (mirror the `interego-restore-job` pattern from `svc-relay-dcr`, but source
  from the restored DB and target the box CSS). Ask me and I'll generate it.

## 6. Bring up the app plane
```bash
docker compose up -d
docker compose logs -f css relay identity
```
Point DNS: A records for `relay`, `identity`, `gate`, `foxxi-bridge`, `bridge`,
`dashboard`, `pgsl-browser`, `acme-id`, `foxxi-*`, `microsite`, and the apex →
the box IP. Caddy fetches TLS certs automatically once DNS resolves.

## 7. Verify
```bash
curl -s https://relay.$DOMAIN/health          # {"status":"ok", ...}
curl -s https://identity.$DOMAIN/ -o /dev/null -w '%{http_code}\n'
# relay logs should show OAuth clients/tokens loaded + no 404 floods
```
- Re-connect the claude.ai Interego connector (new relay URL → fresh DCR).
- Users re-register passkeys at `https://identity.$DOMAIN`.

## 8. Rollback
Nothing on Azure was touched — leave ACA running until the box is proven, then
tear it down (`az group delete -n context-graphs-rg` when you're confident, or
scale each app to `--min-replicas 0` to park it near-free while you decide).

---

## Cost after the move
| | Azure ACA (now) | Hetzner CX42 | Oracle Free |
|---|---|---|---|
| Compute | ~$230/mo (16 GiB always-on) | €16/mo flat | $0 |
| Postgres | ~$15/mo | on-box | on-box |
| Registry | ACR ~$5 | GHCR free / on-box build | GHCR free |
| **Total** | **~$250–690/mo** | **~$18/mo** | **~$0/mo** |

## Notes
- Drop `foxxi-bridge`'s `NODE_OPTIONS` to `--max-old-space-size=3072` (done in the
  compose) — it was 4096 for an 8 GiB ACA replica; tune to your box RAM.
- The `*_REV` / `*_PROBE` env vars were ACA redeploy triggers, not runtime
  config — omitted on purpose.
- Backups: `pg_dump` on a cron + a nightly box snapshot (Hetzner/Oracle both
  offer them) covers the single-box failure mode.
