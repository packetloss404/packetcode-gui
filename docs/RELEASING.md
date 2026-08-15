# Releasing Packetcode (GUI)

How to produce Windows installers for the Packetcode desktop client.

## Prerequisites

- Node.js (with npm)
- Rust stable toolchain (`rustup`, MSVC target on Windows)
- No other tools are required: the Tauri CLI downloads NSIS and the WiX
  toolset automatically on first build.

## Building the installers

```sh
npm install
npm run dist        # alias for `npm run tauri build`
```

This runs the frontend production build (`tsc && vite build`) and then a
release Cargo build, and finally packages the app.

## Where artifacts land

All bundles are written under `src-tauri/target/release/bundle/`:

| Artifact | Path |
| --- | --- |
| MSI installer | `src-tauri/target/release/bundle/msi/Packetcode_<version>_x64_en-US.msi` |
| NSIS installer | `src-tauri/target/release/bundle/nsis/Packetcode_<version>_x64-setup.exe` |
| Bare executable | `src-tauri/target/release/packetcode-gui.exe` |

Bundle targets are pinned to `["msi", "nsis"]` in
`src-tauri/tauri.conf.json` because macOS/Linux bundles cannot be produced
on a Windows host anyway. The NSIS installer performs a **per-user**
install (`installMode: "currentUser"`) — no administrator rights needed —
and is English-only.

To bump the release version, update `version` in both
`src-tauri/tauri.conf.json` and `package.json` (and
`src-tauri/Cargo.toml` to keep them in sync).

## Unsigned binaries and SmartScreen

The installers are **not code-signed**. Windows SmartScreen will show an
"unrecognized app" warning on first run; users must click
"More info" -> "Run anyway". This is expected until a code-signing
certificate is set up (configure `bundle.windows.certificateThumbprint`
or `signCommand` in `tauri.conf.json` when one is available). Do not
"fix" this by asking users to disable SmartScreen.

## The engine is never bundled

The `packetcode` engine (`packetcode.exe`) is deliberately **not**
included in these installers — it is not a sidecar. The GUI is a thin
desktop client; the engine is installed separately via packetcode's own
installer and auto-updates itself independently. Engine updates therefore
never require a GUI release, and vice versa. Do not add `packetcode.exe`
to `bundle.externalBin` / resources.
