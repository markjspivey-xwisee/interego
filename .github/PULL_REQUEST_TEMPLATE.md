## Change

Describe the problem and the resulting behavior.

## Validation

Link the actual checks and their results. Distinguish fixtures, live checks and untested paths.

## Integration impact

For changed ontologies, schemas, catalogs, producers or consumers, identify:

- The authoritative namespace, version and source digest; any separately authored extensions.
- The upstream producers and downstream consumers affected, including independently pinned copies.
- The mapping direction and semantic justification, plus a representative runtime query or workflow that crosses the boundary.
- Intentional exclusions, migration behavior and remaining gaps. A catalog mention or successful transport alone does not establish semantic integration.

For other changes, briefly explain why these integration checks do not apply. Changes under `spec/` or `docs/` also state their layer, following `spec/LAYERS.md`.
