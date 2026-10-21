# PostgreSQL physical write admission

Set `PGSL_PG_MAX_DATABASE_BYTES=48000000000` on every CSS/PGSL PostgreSQL writer connected to the replacement64GB database. The limit is opt-in; unset preserves the existing adapter behavior. No Railway control-plane credential is required.

The adapter takes one PostgreSQL transaction advisory lock shared across tables, pools and replicas before any positive KV SQL. It measures `pg_database_size(current_database())`, checks reserved headroom, and holds that lock through a fresh final measurement and COMMIT or ROLLBACK. The reserved amount is64MiB plus four times cumulative positive key+value input plus8KiB per positive operation. Positive input is limited to16MiB and4096 operations per transaction. Updates and conditional writes count too. SQL failures, pressure refusal and late bound failures roll back the entire transaction; no commit acknowledgement is returned.

Optional overrides are `PGSL_PG_MAX_TRANSACTION_INPUT_BYTES` and `PGSL_PG_WRITE_RESERVE_BYTES`. All values are safe integer byte counts; malformed limits fail at startup. The reserve may be zero for isolated tests; production should retain the default. The exported refusal type is `PgWritePressureError`, with code `PGSL_WRITE_PRESSURE`.

Read-only and delete-only transactions do not take the admission lock or check the ceiling. The collector can therefore reclaim data above the ceiling. A mixed delete/write transaction is a writer, so its whole transaction is refused and rolled back if admission fails.

The ceiling measures physical database files, including heap, indexes and TOAST. WAL and other databases are outside this measurement: the gap between48GB and the64GB volume is deliberate operational headroom, not a promise about PostgreSQL WAL retention. The multiplier is conservative admission reserve rather than an exact physical/WAL accounting formula. Writers bypassing this adapter do not participate in its advisory lock.

Ordinary VACUUM may make pages reusable without reducing `pg_database_size`. The guard intentionally remains closed at its physical threshold until physical size is reduced or an operator reviews the ceiling. It does not grant speculative reuse credits or delete historical resources.
