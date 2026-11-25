## 2026-11-25 — Foxxi: a hosted package's format is read whatever the casing of its manifest

`launchesItself` (src/scorm-hosting.ts), added earlier today, decided whether a
hosted package's units fetch their own cmi5 token by looking for `cmi5.xml` and
`imsmanifest.xml` by exact name. The importer finds both whatever their case,
the SCORM manifest first. A package holding `IMSMANIFEST.XML` beside `cmi5.xml`
was therefore imported as SCORM and served as cmi5, and its SCOs lost the
runtime they report through. A package whose only structure was `CMI5.XML` kept
the bootstrap that spends its token. Both are now compared as the importer
compares them. Found by Codex in review of #1001.
