## 2026-11-19 — Practice Evidence: the voice test no longer has calls that read as a server starting

`deploy/mcp-relay/tests/listen-loopback.test.ts` reads test files for a server's
`.listen(...)` that names no loopback host. The role-play player's voice test
drove the page's speech function, also called `listen`, through a stand-in with
the same method name, twelve times. None opens a socket, but each reads to that
scan as an unguarded server, and the way to pass was to skip the whole file. A
server added to the file later would then have gone unread.

The stand-in's method is now `tapMic`. The page's own function keeps its name.
The file checks itself for the pattern, so it can be scanned like any other and
needs no exemption.
