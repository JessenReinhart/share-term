# AGENTS.md

Guidance and instructions for AI agents working in `share-term`.

---

## 1. Project Overview

`share-term` is a Node.js CLI tool that streams terminal output, log files, stdin streams, tmux sessions, or interactive PTY shells to a mobile browser over local Wi-Fi via HTTP + WebSocket and QR code discovery.

### Key Architecture
- **CLI Wizard & Entrypoint** (`src/cli.ts`): Parses CLI arguments, prompts user to select a source using `@clack/prompts` and `@inquirer/prompts`, and handles lifecycle cleanup.
- **Server** (`src/server.ts`): Combined HTTP static file server and WebSocket server on a single port (default 8080 or next free port). Protects against directory traversal.
- **Log Sources** (`src/watcher.ts`, `src/pty.ts`, `src/sessions.ts`):
  - `LogSource` interface: `start(onLine: (line: string) => void): Promise<void> | void`, `stop(): void`, optional `onSize?(cb: (cols: number, rows: number) => void): void`.
  - `FileTailer`: Incremental byte reading via `chokidar` watching.
  - `StdinSource`: Pipes Node process `process.stdin`.
  - `PtySource`: Cross-platform interactive pseudo-terminal via `node-pty` (ConPTY on Windows, openpty on POSIX).
  - `TmuxSessionSource`: Captures and taps running tmux panes.
- **Network & QR** (`src/network.ts`, `src/qr.ts`): Detects local IPv4 network address and prints half-block ANSI QR code to terminal.
- **Web Client** (`public/index.html`): Mobile PWA terminal UI using vendored `xterm.js` and fit addon (no external CDN required).
- **Vendor Copy Script** (`scripts/copy-vendor.mjs`): Copies xterm assets from `node_modules` to `public/vendor`.

---

## 2. Tech Stack & Environment

- **Runtime**: Node.js >= 18 (ESM, `"type": "module"`)
- **Language**: TypeScript 5.7+ (Target: `ES2022`, Module: `NodeNext`, ModuleResolution: `NodeNext`)
- **Key Dependencies**:
  - `node-pty`: Native PTY spawning
  - `ws`: WebSocket server
  - `chokidar`: File tailing watcher
  - `@clack/prompts`, `@inquirer/prompts`, `picocolors`: Terminal UI
  - `qrcode-terminal`: Terminal QR generation
  - `get-port`: Dynamic port fallback
- **Dev Tools**: `tsx` (fast TS execution), `tsc` (compiler)

---

## 3. Directory Layout

```text
share-term/
├── public/
│   ├── index.html           # Zero-CDN mobile web client (xterm.js receiver)
│   └── vendor/              # Bundled xterm.js runtime assets (gitignored)
├── scripts/
│   └── copy-vendor.mjs      # Copies xterm distribution files into public/vendor
├── src/
│   ├── cli.ts               # CLI entrypoint, argument parsing, interactive picker
│   ├── network.ts           # LAN IPv4 detection
│   ├── pty.ts               # Interactive shell source (node-pty)
│   ├── qr.ts                # ANSI terminal QR code rendering
│   ├── server.ts            # HTTP + WebSocket server, path traversal guard
│   ├── sessions.ts          # Tmux discovery and session attach source
│   └── watcher.ts           # FileTailer, StdinSource, findLogFiles, LogSource
├── .gitignore
├── package.json
├── README.md
└── tsconfig.json
```

---

## 4. Development Workflow & Commands

```bash
# Install dependencies
npm install

# Run CLI directly in dev mode (via tsx)
npm run dev

# Run CLI with a custom command stream
npx tsx src/cli.ts "npm test"

# Build project (compiles TypeScript + copies vendor assets + sets chmod)
npm run build

# Run compiled build
npm start

# Symlink binary globally for local testing
npm link
```

---

## 5. Coding Standards & Conventions

### Imports & Modules
- **ESM syntax only**: Use native `import` / `export`.
- **Node built-ins**: Prefix all Node core modules with `node:` (e.g., `import fs from "node:fs";`, `import path from "node:path";`).
- **Relative import paths**: Relative imports must include `.js` extension (e.g., `import { getLocalIp } from "./network.js";`).

### Terminal & Process Safety
- **Terminal Hygiene**: Clean up terminal state (reset mouse tracking, bracketed paste mode, show cursor) on process exit or signal interruptions (`SIGINT`, `SIGTERM`).
- **Path Traversal Protection**: Any file server endpoint must sanitize paths and ensure requests stay within `public/`.
- **Cross-Platform Compatibility**: Use `node:os` or `process.platform` checks when dealing with shell paths (`cmd.exe` vs `/bin/bash`), PATHEXT, and PTY environments.
- **WebSocket Safety**: Wrap message broadcasts in try/catch to avoid breaking the server when a client socket drops abruptly.

---

## 6. Guidelines for Agents

- **Run build check after code changes**: Always run `npm run build` to verify TypeScript compilation and vendor script execution.
- **Do not commit build artifacts**: Keep `dist/` and `public/vendor/` out of version control (enforced in `.gitignore`).
- **Inspect `node-pty` native compilation**: If running into native build issues with `node-pty`, verify local C/C++ build tools and Node headers.
