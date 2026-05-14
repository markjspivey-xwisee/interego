# Interego Validator-as-Agent Service

A thin orchestrator that lets a SHACL validator participate in a pod's
federation as a first-class `cg:AuthorizedAgent` (role `Validator`) rather
than acting as an out-of-band gatekeeper. See `spec/LAYERS.md` — this is a
Layer 3 reference implementation; the protocol does not mandate it.

## Bring your own SHACL engine

This container runs **no SHACL engine in-process** and has **no RDF or SHACL
dependency** — only `express` (health/trigger HTTP) and `ws` (subscription
transport). It stays a thin orchestrator:

```
descriptor published → fetch Turtle → POST to your SHACL engine
  → wrap the sh:ValidationReport as a finding → publish_context back to the pod
```

You bring the engine. Run any SHACL implementation — [pyshacl][pyshacl],
[rdf-validate-shacl][rvs], Apache Jena, TopBraid — behind a small HTTP
adapter, and point `SHACL_ENDPOINT` at it.

### Contract

The adapter must accept and return JSON over `POST`:

**Request** (`Content-Type: application/json`):

```json
{
  "data": "<descriptor Turtle>",
  "dataFormat": "text/turtle",
  "shapes": "<shape-set Turtle>",
  "shapesFormat": "text/turtle"
}
```

`shapes` / `shapesFormat` are present only when `SHAPES_URL` is configured;
otherwise the adapter should validate against its own configured shape set.

**Response** (`Content-Type: application/json`):

```json
{
  "conforms": true,
  "report": "<sh:ValidationReport in Turtle>"
}
```

`conforms` (boolean) is required. `report` is optional — if omitted, the
validator synthesizes a minimal `sh:ValidationReport` carrying just
`sh:conforms`.

The contract is intentionally W3C-standard on both ends (Turtle in,
`sh:ValidationReport` out), so no Interego-specific knowledge lives in the
engine adapter.

### Example adapter — pyshacl

```python
from flask import Flask, request, jsonify
from pyshacl import validate

app = Flask(__name__)

@app.post("/")
def shacl():
    body = request.get_json()
    conforms, report_graph, _ = validate(
        body["data"],
        shacl_graph=body.get("shapes"),
        data_graph_format=body.get("dataFormat", "turtle"),
        shacl_graph_format=body.get("shapesFormat", "turtle"),
    )
    return jsonify(conforms=conforms, report=report_graph.serialize(format="turtle"))
```

### Example adapter — rdf-validate-shacl (Node)

```js
import express from 'express';
import SHACLValidator from 'rdf-validate-shacl';
import { Parser, Writer } from 'n3';
import factory from 'rdf-ext';

const app = express();
app.use(express.json({ limit: '4mb' }));

app.post('/', async (req, res) => {
  const data = factory.dataset(new Parser().parse(req.body.data));
  const shapes = factory.dataset(new Parser().parse(req.body.shapes ?? ''));
  const report = new SHACLValidator(shapes).validate(data);
  const reportTurtle = await new Promise((resolve) =>
    new Writer().addQuads([...report.dataset], (_e, t) => resolve(t)));
  res.json({ conforms: report.conforms, report: reportTurtle });
});

app.listen(8088);
```

## No-op mode

When `SHACL_ENDPOINT` is unset the validator runs in **no-op mode**:
incoming events are still recorded and surfaced on `/health`, but nothing
is validated or published. This is a deliberate honest no-op — the service
never pretends a descriptor passed validation it never ran.

`/health` reports `"mode": "active"` or `"mode": "no-op (SHACL_ENDPOINT unset)"`.

## Environment

| Variable | Purpose |
|---|---|
| `IDENTITY_URL` | Identity server base URL (for agent registration) |
| `RELAY_URL` | Relay base URL (for `/tool/publish_context`) |
| `POD_URL` | Target pod root, e.g. `https://css.example/u-pk-abc/` |
| `AGENT_ID` | Self identity, e.g. `urn:agent:validator:core-1.0:markj` |
| `AGENT_BEARER` | Pre-issued identity bearer (OAuth later) |
| `OWNER_WEBID` | Pod owner WebID stamped on published findings (optional) |
| `SHACL_ENDPOINT` | Your SHACL engine adapter URL (BYO) |
| `SHACL_ENDPOINT_TOKEN` | Optional bearer for the SHACL engine |
| `SHAPES_URL` | Turtle shape set to validate against (optional) |
| `PORT` | Health-check server port (default `9090`) |

`@interego/core` exports its SHACL shapes as Turtle strings — publish one
to a URL and point `SHAPES_URL` at it, or let the engine carry its own.

## HTTP surface

- `GET /health` — status, counters, mode, config presence flags.
- `POST /validate` — manual trigger; body `{ "descriptorUrl": "..." }`.
  Returns `{ ok, eventsProcessed, result }` where `result` is
  `{ validated, conforms?, published, error? }`. Useful for CI smoke
  tests and for driving the validator before the subscription loop is
  wired.
- `GET /.well-known/security.txt` — RFC 9116 disclosure contact.

[pyshacl]: https://github.com/RDFLib/pySHACL
[rvs]: https://github.com/zazuko/rdf-validate-shacl
