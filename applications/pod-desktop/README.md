# Interego for Windows

**Layer 3 consumer application, preview.** Install Interego and create a local pod without a terminal, Node.js, Docker, or a cloud account. The app includes its runtime and runs it on your computer. The existing hosted service remains available through the explicit **Use hosted Interego** action, which opens the hosted dashboard in your browser. Local startup does not sign in to or contact that service.

## Using the app

1. Run the Windows setup executable and open Interego.
2. Choose **Set up on this computer**. The app creates a pod and protects its notes key with Windows storage.
3. Save a private note. Titles and note bodies are encrypted before they reach the pod's storage.
4. Close and reopen the app to resume the same pod. **Stop Interego** pauses the pod while keeping its notes; the app also stops its runtime when you quit.
5. Use **Back up notes** to create an encrypted `.interego` file. Keep its passphrase separately. **Restore a notes backup** is available before creating a new space, so existing notes are not overwritten. An interrupted restore can be finished using the same backup.

The Windows data folder is separate from the installed program, normally under `%APPDATA%/Interego`. **Open data folder** opens the actual location. Uninstalling the app preserves this folder. Other processes running under your Windows account remain inside the local trust boundary; protected storage is not a promise of protection against malware acting as you.

The **Connections** page pairs local MCP clients with separate read and append permissions, expiry and Disconnect controls. See [agent setup](AGENT-CONNECTIONS.md) for ChatGPT desktop, Codex, Claude, Grok Build, OpenClaw and other local clients. Notes an agent reads may be sent to its AI provider; local storage does not make that inference local. Setup does not expose the pod key or storage credential.

Federation stays off. Automatic cloud synchronization, shared workspaces, cloud-only agent access and a local federation transport are later capabilities. The existing hosted and personal-bridge deployments remain separate supported paths. A notes backup preserves this app's current notes and encryption key, including historical connection labels; it does not restore agent credentials and is not a byte-for-byte migration archive of every signed record in an arbitrary pod.

## Windows preview signing

The build records the actual Authenticode status in `release/BUILD-INFO.json` and produces `SHA256SUMS.txt`. With no signing certificate configured, this is an **unsigned preview**, and Windows may display a publisher or SmartScreen warning. Signing credentials can be supplied to the build; a certificate is not fabricated or silently assumed. Packaging never publishes a release automatically.

## Build and verification

From the repository root, after installing the workspace dependencies:

```sh
npm run build
npm run package:win --workspace @interego/pod-desktop
npm run smoke:packaged --workspace @interego/pod-desktop
```

The packaging stage copies an explicit production dependency graph, including the built Interego packages and CSS configuration/assets. It does not copy the repository or install packages at startup. CSS stays outside an asar archive so its configuration loader can resolve its packaged files. The installer is per-user and requires no elevation.

For edits confined to this app's main process, preload, renderer or HTML, `npm run package:win:refresh --workspace @interego/pod-desktop` can reuse an already staged runtime graph. Run the full packaging command after any runtime workspace or dependency change, even if its version and dependency names stayed the same. CI always uses the full command.

The packaged smoke starts the shipping application with a new temporary data directory and real Windows-protected keys. It creates encrypted notes through both the isolated window and separately launched MCP companion processes, verifies read/save scopes and revocation, stops and reopens the runtime, checks persistence and disabled federation, and fails on non-loopback Node connections in the app. A fresh app process then reopens the same directory, verifying protected keys and revoked grants survive quitting. Each expanded lifecycle has a five-minute deadline. Renderer tests exercise the actual HTML and renderer bundle; controller tests exercise real storage, encryption, authorization at queued execution, backup authentication, restore recovery and process-lock checks.

The Windows packaging workflow uploads the installer, checksums and signature report as PR artifacts. Consumer installers are built from reviewed source without auto-deploying the hosted services. For an isolated developer or QA run, `INTEREGO_POD_DATA_DIR` can select a separate absolute user-data directory; normal users need no configuration.
