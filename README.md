# Packetcode Desktop

A native desktop client for [packetcode](https://github.com/packetloss404/packetcode), the keyboard-first terminal coding agent. Tauri 2 + React 19, styled with the Packet family's Graphite design system.

Packetcode Desktop does **not** bundle or reimplement the agent. It drives the separately installed `packetcode` binary over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP v1, NDJSON JSON-RPC over stdio). Update packetcode and the desktop app is instantly running the new engine — no app release required.

## Features

- **Chat with the real engine** — streaming responses, agent thoughts, markdown rendering, tool-call cards with live output
- **Interactive approvals** — packetcode's permission requests surface as inline cards; allow or reject without leaving the flow
- **Session history & resume** — sessions grouped by project in the sidebar, resumed over ACP `session/load` with full transcript replay
- **Model picker** — per-session provider/model choice served by the engine's model catalog
- **Guided install** — if no engine is found (or it's too old), the app offers packetcode's official install script with live output, then verifies the result

## Install

1. Install packetcode (or let the app's install gate do it on first launch):

   ```powershell
   & ([scriptblock]::Create((Invoke-WebRequest https://raw.githubusercontent.com/packetloss404/packetcode/main/install.ps1).Content))
   ```

2. Install Packetcode Desktop from the release MSI/NSIS bundle, or build from source (below).

The app resolves the engine from `PACKETCODE_GUI_ENGINE` (explicit override), then PATH, then packetcode's documented default install location.

## Develop

Prerequisites: Node 20+, Rust stable, and a `packetcode` binary (a dev build works — point `PACKETCODE_GUI_ENGINE` at it).

```powershell
npm install
$env:PACKETCODE_GUI_ENGINE = "D:\path\to\packetcode.exe"   # optional override
npm run app                                                 # tauri dev
```

Tests:

```powershell
npm run build            # tsc + vite
cd src-tauri
cargo test               # unit + integration tests against a mock ACP engine
```

The integration suite (`src-tauri/tests/acp_stream.rs`) drives the bridge against `src-tauri/testdata/mock-engine.mjs`, a dependency-free Node mock that speaks the engine's exact ACP framing — string request ids, real option ids, cancellation semantics.

## Architecture

```
React 19 UI  ──invoke/events──  Tauri (Rust)  ──ACP over stdio──  packetcode.exe
   src/                         src-tauri/src/engine.rs            (installed separately)
```

- `src-tauri/src/engine.rs` — engine bridge: binary resolution, `doctor --json` probe + minimum-version gate, `AcpBridge` (JSON-RPC client with an event-sink trait), installer command
- `src/acp/` — protocol types and the typed frontend bridge
- `src/session/useSession.ts` — reduces ACP `session/update` streams into the renderable timeline
- `src/styles/tokens.css` — Graphite design tokens, mirrored from PacketADE

### Engine contract

Spec surface consumed: `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/update`, `session/request_permission`.

Vendor extensions (feature-detected via `agentCapabilities._packetcode` in the `initialize` response, all optional — the app degrades gracefully on older engines):

| Method | Purpose |
|---|---|
| `_packetcode/sessions/list` | Session history for the sidebar (disk fallback exists) |
| `_packetcode/models/list` | Provider/model catalog for the picker |
| `session/new` `_packetcode: {provider, model}` | Per-session model override |

Minimum engine version: `MINIMUM_ENGINE_VERSION` in `src-tauri/src/engine.rs`. packetcode keeps the ACP surface additive; the app must degrade, not crash, when a method is missing.

## License

MIT
