## 2026-11-24 — I2IDL-X restores its pinned upper sources in CI

The native, parity and historical oracle jobs recover the published source
bytes held by the content-addressed Foxxi build seed. A source enters the
cache only when its SHA-256 matches the checkout's manifest. Source
preparation handles unavailable or newer pins. The original trace and
implementation retain their own checkout.
