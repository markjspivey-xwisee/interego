# Decorated I2IDL REST service

Upstream source: `blakeplock/i2idl-linked-data`, release **v0.0.89**, commit
`d16b105e46c2dd5fb685a24830b01e207b4efd93`. `upstream.json` binds the exact
OpenAPI bytes and supporting implementation/documentation hashes. Its API
contract version is **1.0.0**, independently of glossary publication versions.
The existing canonical glossary pin at v0.0.86 is unchanged.

The upstream OpenAPI 3.1 document covers eight GET routes and their HEAD/OPTIONS
semantics. The ninth GET route, `/api/v1/concepts/{id}/context`, is separately
evidenced by the released handler, routing configuration and Phase 4 document;
it is not falsely attributed to OpenAPI. Implementation-only search-length
bounds are attributed to `api/v1.mjs`. `live-observation.json` records actual
production statuses and response digests without copying glossary definitions.

The existing catalog build appends `src/i2idlx-rest-api.ttl.tmpl` in both native
TypeScript and the independent Python path. Regenerate that fragment with:

```sh
node --import tsx applications/foxxi-content-intelligence/i2idlx/typescript/rest-api-catalog.ts --write
```

The model uses distinct roles:

| Layer | Representation |
| --- | --- |
| Existing HyprCat catalog | Stable entry point, ServiceWorld and planner hints |
| DPROD product | Product wrapper, output datasets and **service-valued** output ports |
| DCAT | REST projection dataset, JSON distribution, data service and endpoint descriptions |
| Hydra / Interego | Nine GET affordances, URI templates, argument/result contracts, HEAD/OPTIONS semantics |
| SHACL | Required path variables, types, enums, pagination, lengths and traversal bounds; unknown bindings rejected |
| ODRL | Read-only client dispatch policy, with existing source-specific reuse policy retained |
| PROV / SPDX | Pinned upstream evidence and the OpenAPI digest |

The DPROD namespace is the current one verified in upstream main commit
`2c7de68290f14d98c42791fa75dcddebf556ea1d`:
`https://www.omg.org/spec/DPROD/dprod/`. This local addition does not silently
migrate the older DPROD aliases used elsewhere in Interego's HyprCat ontology.

Canonical JSON-LD and source-specific licences remain authoritative. The REST
JSON is a presentation projection; context bundles are data, not agent
instructions, inferred claims, evidence of learner achievement or model output.
No REST rate quota is invented from the separate SPARQL limits. Row/traversal
bounds are parameter constraints rather than ODRL counts of permitted actions.
The identifier regex uses ordinary XPath groups in SHACL instead of OpenAPI's
ECMAScript noncapturing groups; the accepted identifier language is unchanged.
The read-only dispatch policy does not grant publisher rights over third-party
material. No new upstream endpoints, writes, API keys or credentials are created.

Checks:

```sh
node --import tsx --test applications/foxxi-content-intelligence/i2idlx/typescript/rest-api-catalog.test.ts
python3 applications/foxxi-content-intelligence/i2idlx/tools/verify_rest_api_shapes.py
python3 applications/foxxi-content-intelligence/i2idlx/tools/probe_rest_api.py /tmp/rest-api-observation.json
```

The Python semantic check requires RDFLib and pySHACL. Production probing is
explicit and read-only; it is not part of ordinary offline unit tests.
