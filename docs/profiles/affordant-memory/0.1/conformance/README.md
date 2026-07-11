# AMEP 0.1 conformance fixtures

The fixtures operationalize this profile without changing Interego L1
conformance. Positive cases cover all six acts, both actor classes, contextual
reuse, candidate-versus-committed memory, and deterministic composition.
Negative cases each pin a named profile shape.

`manifest.json` also checks three HTTP Problem Details examples and compares a
human projection with an agent projection to ensure their advertised action
contracts are byte-for-byte equivalent after actor-specific fields are removed.

Run from the repository root:

```bash
npm run test:amep
```

