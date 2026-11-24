## 2026-11-24 — I2IDL-X restores its pinned DUL snapshot in CI

The native, parity and historical oracle jobs can load DUL from the
content-addressed Foxxi build seed. They check the extracted source against
the unchanged manifest SHA-256 before it enters the cache. The original
trace and implementation retain their own checkout.
