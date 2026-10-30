# Windows identity companion

`Interego-Identity.exe` is the console host for Chrome and Edge's
`com.interego.identity` Native Messaging connection. It is packaged under
`dist/native-host/` by `node tools/build-native-host.mjs`. The desktop installer
registers its manifest; this build tool never changes browser settings or the
registry.

The consumer target is 64-bit Windows 10/11 with the OS-provided .NET Framework
4.x. The compiler is `Framework64/v4.0.30319/csc.exe`; the executable uses CLR 4
APIs and Windows CNG/DPAPI. It needs no separate modern .NET runtime, Node.js, or
Electron process. Executable compilation is skipped on other operating systems.

The host receives the extension origin from Chromium's process argument, creates
one private channel for the process, and accepts only `start`, `poll`, and
`cancel` messages. It never exposes identity creation, owner approval, a private
key, or arbitrary signing to a browser. Closing the browser port makes a best
effort authenticated `close` request. The app also expires abandoned requests.

Frames are bounded to 64 KiB with strict UTF-8 decoding. Loopback messages reuse
the desktop's `agent-protocol.ts` HKDF/AES-256-GCM envelope with a separate random
transport ticket. HTTP accepts only the exact stored `127.0.0.1` endpoint; it
disables proxies and redirects, limits response size, and uses 15-second network
timeouts. Replies must authenticate the current session, connection, and request.

The desktop invokes `--protect-ticket` with ticket JSON on standard input. This
mode emits only base64 Windows CurrentUser DPAPI ciphertext. Normal operation
reads that ciphertext from `%APPDATA%/Interego/identity-browser/ticket.bin` and
the nonsecret broker location from `endpoint.json` beside it. These files contain
no identity signing key. An absolute `--pod-data-dir` argument or
`INTEREGO_POD_DATA_DIR` supports isolated testing.

Run the actual Windows executable tests from the repository root:

```powershell
npx vitest run applications/pod-desktop/tests/native-identity-host.test.ts
```

They compile the host, use real CurrentUser DPAPI, exercise CNG encryption in both
directions against Node's existing protocol, and check persistent framing, origin
validation, tampered replies, bounded input, and port cancellation. They make no
live browser or registry changes and skip the Windows-only executable on Linux.
