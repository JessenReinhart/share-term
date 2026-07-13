# share-term

> Stream your terminal logs to your phone by scanning a QR code. Zero config, real-time, ANSI-aware.

`share-term` lets you mirror a log file (or any `stdin` stream) from your laptop to your
smartphone over your local Wi-Fi. It spins up a tiny HTTP + WebSocket server, prints a QR
code in your terminal, and streams new log lines to the phone in real time — rendered with
full ANSI colors, just like a real terminal.

```
$ share-term
✔ Scanning for log files…  Found 3 log file(s)
? What would you like to stream to your phone?  › dev.log

  Server ready
  http://192.168.1.42:8080

  █▀▀▀▀▀▀▀▀█  ← scan this with your phone
  █ ▄▄▄ █ █
  ...
```

## Features

- **TUI wizard** (built on `@clack/prompts`) to pick a `.log` file or enter Pipe Mode.
- **Automatic LAN IP detection** — uses your real Wi-Fi IP, not `127.0.0.1`.
- **QR code in the terminal** (no app install needed on the laptop).
- **Zero-config PWA receiver** — a single responsive HTML file served from the CLI.
- **ANSI color rendering** on the phone (custom SGR parser, no CDN needed).
- **`tail -f` style watching** via `chokidar` — streams only appended bytes (low CPU).
- **Phone-side UX**: auto-scroll toggle, clear button, `INFO`/`WARN`/`ERROR` filter pills.
- **Graceful handling** of phone disconnects, file rotation, and port conflicts.

## Install (from source / for development)

```bash
git clone <your-fork>
cd share-term
npm install
npm run build
npm link          # makes `share-term` available globally, symlinked to this repo
```

After `npm link`, `share-term` resolves to `dist/cli.js` in your working copy, so you can
edit `src/*` and re-run `npm run build` (or use `npm run dev` to run TypeScript directly
with `tsx`, no build step).

## Usage

```bash
# Stream a log file (interactive picker)
share-term

# Stream whatever is piped in (auto-detected when stdin is not a TTY)
npm run dev | share-term
docker logs -f my-container | share-term
tail -f app.log | share-term
```

Then:

1. Make sure your phone is on the **same Wi-Fi** as your laptop.
2. Scan the QR code (or open the printed `http://<lan-ip>:<port>` URL).
3. Watch logs appear live. Use the pills to filter, toggle auto-scroll, or clear.

Press `Ctrl+C` in the terminal to stop the server.

## Architecture

```
┌────────────┐   TUI (clack)   ┌──────────────────────────┐
│  Terminal  │ ───────────────▶│  src/cli.ts (orchestrator)│
└────────────┘                 └──────────────────────────┘
                                       │
            ┌──────────────────────────┼───────────────────────────┐
            │                          │                           │
   ┌────────▼─────────┐      ┌─────────▼────────┐      ┌──────────▼─────────┐
   │ src/watcher.ts   │      │ src/server.ts     │      │ src/network.ts +   │
   │ FileTailer /     │─────▶│ HTTP + WebSocket  │─────▶│ src/qr.ts          │
   │ StdinSource      │      │ (broadcast lines) │      │ (IP + QR render)   │
   └──────────────────┘      └─────────┬────────┘      └─────────────────────┘
                                       │  ws://<lan-ip>:<port>
                                       ▼
                            ┌──────────────────────────┐
                            │ public/index.html (PWA)  │
                            │ ANSI parser + filters    │
                            └──────────────────────────┘
```

| Module                | Responsibility                                              |
| --------------------- | ----------------------------------------------------------- |
| `src/cli.ts`          | TUI wizard, source selection, server/QR bootstrapping.      |
| `src/watcher.ts`      | `FileTailer` (`tail -f`), `StdinSource`, log-file discovery.|
| `src/server.ts`       | HTTP static server + WebSocket broadcast + heartbeat.       |
| `src/network.ts`      | Detect the real local IPv4 address.                         |
| `src/qr.ts`           | Render the connection URL as a terminal QR code.            |
| `public/index.html`   | The mobile receiver: ANSI→HTML, filters, auto-scroll.      |

## Protocol

The WebSocket sends JSON messages:

- `{ "type": "meta", "file": "<label>" }` — sent on connect, names the source.
- `{ "type": "line", "text": "<raw log line with ANSI codes>" }` — one per new line.

## Requirements

- Node.js >= 18
- Phone + laptop on the same local network (no internet egress required).

## License

MIT
