# packetcode-gui

Desktop client for [packetcode](https://github.com/packetloss404/packetcode), the terminal coding agent. Tauri 2 + React 19.

packetcode-gui does **not** bundle or reimplement the agent. It resolves the separately installed `packetcode` binary, health-checks it with `packetcode doctor --json`, version-gates it, then spawns `packetcode acp` and speaks [Agent Client Protocol](https://agentclientprotocol.com) v1 over stdio. Updating packetcode updates the engine this app drives — no GUI release required.

## Layout

- `src/` — React frontend. Design tokens mirror PacketADE's Graphite scheme (`src/styles/tokens.css`).
- `src/acp/` — ACP types and the typed bridge to the Rust side.
- `src/session/` — reducer turning ACP `session/update` notifications into a renderable timeline.
- `src-tauri/src/engine.rs` — engine bridge: probe, version gate, spawn, NDJSON JSON-RPC client, permission round-trip.

## Develop

```bash
npm install
npm run app        # tauri dev (starts vite + the desktop shell)
```

Requires a `packetcode` binary on PATH (or set `PACKETCODE_GUI_ENGINE` to an absolute path — useful for driving a dev build).

## Engine contract

- Minimum engine version: `src-tauri/src/engine.rs` `MINIMUM_ENGINE_VERSION`.
- The ACP surface this client consumes: `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/update` (all variants), `session/request_permission`.
- Vendor extension: `_packetcode/sessions/list` (feature-detected via `agentCapabilities._packetcode.sessionsList` in the `initialize` response). When the engine predates it, the sidebar falls back to reading `~/.packetcode/sessions/*.json` directly.
- packetcode's server keeps this surface additive; if a method is missing, degrade the feature, don't crash.
