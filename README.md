# Packetcode Desktop

A native desktop client for [packetcode](https://github.com/packetloss404/packetcode), the keyboard-first terminal coding agent. Tauri 2 + React 19, styled with the Packet family's Graphite design system.

Packetcode Desktop does **not** bundle or reimplement the agent. It drives the separately installed `packetcode` binary over the [Agent Client Protocol](https://agentclientprotocol.com) (ACP v1, NDJSON JSON-RPC over stdio). Update packetcode and the desktop app is instantly running the new engine — no app release required.

## Features

- **Chat with the real engine** — streaming responses, agent thoughts, markdown rendering, tool-call cards with live output
- **Projects** — open any directory as a project; recent projects and their sessions live in the sidebar
- **Interactive approvals** — packetcode's permission requests surface as inline cards; allow or reject without leaving the flow. Nothing is decided for you in silence: the one request the app cannot route (no open session owns it) is declined and reported as a dismissible notice, naming the tool call it refused
- **Per-session permission modes** — read-only through bypass, chosen in the composer, enforced (and capped) by the engine
- **Concurrent sessions** — start a turn, switch away, come back to it finished; sidebar dots show running (blue) and needs-approval (amber) per session
- **Bounded residency** — idle sessions you have moved on from are handed back with ACP `session/close`, so browsing history no longer piles up live runtimes (and their MCP processes) inside the engine; anything running or waiting on an approval is never released, and reopening a released session just resumes it
- **Session history & resume** — sessions grouped by project, resumed over ACP `session/load` with full transcript replay, live titles, inline rename
- **Slash commands and @ mentions** — the composer's `/` menu lists your markdown commands (the engine expands them server-side) and `@` searches project files
- **Model picker** — per-session provider/model choice served by the engine's model catalog
- **Usage statusline** — context occupancy, cumulative tokens, and cost under the composer after every turn
- **MCP servers, only if you say so** — packetcode's own `[mcp.<name>]` servers are local programs, so the app never starts them behind your back: on first launch it lists them by name and command and asks, remembers the answer for the machine, and puts a click-to-expand chip above the composer showing what is running (amber only when a server actually failed) with the switch to turn it off again
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
- `src/session/store.ts` / `router.ts` / `SessionsProvider.tsx` — sessionId-keyed store, one global ACP listener pair, and the provider that owns both; sessions keep streaming while their view is unmounted
- `src/styles/tokens.css` — Graphite design tokens, mirrored from PacketADE

### Engine contract

Spec surface consumed: `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/update`, `session/request_permission`.

Vendor extensions (feature-detected via `agentCapabilities._packetcode` in the `initialize` response, all optional — the app degrades gracefully on older engines):

| Method | Purpose |
|---|---|
| `_packetcode/sessions/list` | Session history for the sidebar; an engine that advertises it as absent is never asked, and the sidebar reads `~/.packetcode/sessions` instead (and says so) |
| `_packetcode/sessions/rename` | Inline session rename from the sidebar |
| `_packetcode/sessions/usage` | Token/cost usage for the statusline (newer engines also attach usage to prompt results) |
| `_packetcode/models/list` | Provider/model catalog for the picker |
| `_packetcode/commands/list` | Slash commands for the composer's `/` menu. The engine reports only markdown commands from `~/.packetcode/commands` and `<cwd>/.packetcode/commands`; its built-in slash commands are TUI affordances with no ACP equivalent. It expands a leading `/name` in `session/prompt` into the command's prompt |
| `_packetcode/project/files` | Project file search for the composer's `@` menu, using the engine's own ignore rules |
| `_packetcode/mcp/list` | MCP servers: with a `sessionId`, that session's live fleet (tool counts, startup failures); without one, the engine's configured servers — read before any session exists, which is what the consent dialog lists |
| `initialize` `agentCapabilities._packetcode.mcpDefaults` | The engine's promise that an OMITTED `mcpServers` on `session/new` means "use your own configured servers". Read strictly: engines that never promised it reject the omission with invalid-params, so the app keeps sending `[]` |
| `session/new` `_packetcode: {provider, model, permissionMode}` | Per-session model and permission-mode overrides (the engine caps requested modes at its configured profile) |
| `initialize` `agentCapabilities._packetcode` | Advertised extension flags, allowed `permissionModes`, and `defaultPermissionMode` — the app offers only what the engine will accept |

Both composer affordances degrade to an empty list on engines without them, and the composer's placeholder drops the promises it cannot keep — down to a bare "Do anything" when neither is served.

`mcpServers` is the one field where absence is not neutrality: `[]` means "run this session with no MCP servers", a populated list means "exactly these", and only OMITTING the field asks a capable engine for its own configured fleet. Since that fleet is a set of local subprocesses, the app sends `[]` — starting none — until the user has seen the list of commands and agreed, and it stores that answer per machine (`packetcode.mcpInherit` in localStorage). The choice is reversible from the composer chip and applies to new sessions, exactly like the model and permission-mode pickers; running sessions keep the fleet they were opened with.

The chip's live status is read when a session starts, again when a turn completes, and again when the panel is opened — a server that dies mid-turn is reported at the next of those, and the panel labels what it shows ("status as of the last completed turn") rather than implying a live subscription the protocol does not offer.

Minimum engine version: `MINIMUM_ENGINE_VERSION` in `src-tauri/src/engine.rs`. packetcode keeps the ACP surface additive; the app must degrade, not crash, when a method is missing.

## License

MIT
