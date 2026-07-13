#!/usr/bin/env node
/**
 * share-term — stream your terminal to your phone via QR code.
 *
 * Flow:
 *   1. Detect active terminal sessions (tmux panes); fall back to *.log files.
 *   2. Show a searchable TUI to pick a session / file or "Pipe Mode".
 *   3. Start an HTTP + WebSocket server, detect LAN IP, render a QR code.
 *   4. Tail the selected source and broadcast new lines to connected phones.
 */

import path from "node:path";
import fs from "node:fs";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import process from "node:process";
import * as p from "@clack/prompts";
import pc from "picocolors";
import getPort from "get-port";
import { search } from "@inquirer/prompts";

import { getLocalIp } from "./network.js";
import { renderQr } from "./qr.js";
import { ShareServer } from "./server.js";
import {
  FileTailer,
  StdinSource,
  findLogFiles,
  type LogSource,
} from "./watcher.js";
import { TmuxSessionSource, findTerminalSessions } from "./sessions.js";
import { PtySource } from "./pty.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

/**
 * Disable terminal input-reporting modes (mouse tracking, bracketed paste)
 * that a previously-aborted session may have left enabled. Leftover modes
 * inject escape sequences into prompts, making text input unusable.
 */
function disableInputModes(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(
    "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l",
  );
}

/** Fully restore the terminal after we take it over (cursor, modes, reset). */
function restoreTerminal(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(
    "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[0m",
  );
}

const PIPE_VALUE = "__pipe__";

/**
 * If extra non-flag arguments are given (e.g. `share-term sprint`), treat them
 * as a command to run and share. A bare script name that matches an npm script
 * in the cwd is expanded to `npm run <script>` for convenience.
 */
async function resolveCommandArg(): Promise<string | null> {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (positional.length === 0) return null;
  const raw = positional.join(" ");
  if (positional.length === 1) {
    try {
      const pkg = JSON.parse(
        await fs.promises.readFile(path.join(process.cwd(), "package.json"), "utf8"),
      );
      if (pkg.scripts && pkg.scripts[positional[0]]) return `npm run ${positional[0]}`;
    } catch {
      /* no package.json / not JSON — run the arg verbatim */
    }
  }
  return raw;
}

async function main(): Promise<void> {
  disableInputModes();
  p.intro(pc.bgBlue(pc.white(" share-term ")) + pc.dim("  v1.0.0"));

  const cwd = process.cwd();

  // `share-term <command>` → share that command's output directly (no picker).
  const command = await resolveCommandArg();
  const source = command
    ? {
        instance: new PtySource({ command }),
        label: command,
        takesTerminal: true,
        raw: true,
      }
    : await chooseSource(cwd);

  // Pick an available port (falls back from 8080 if busy).
  const port = await getPort({ port: 8080 });

  const ip = getLocalIp();
  if (!ip) {
    p.cancel(
      "Could not detect a local network IP. Connect to Wi-Fi or pass one explicitly.",
    );
    process.exit(1);
  }

  const url = `http://${ip}:${port}`;

  const server = new ShareServer({ publicDir: PUBLIC_DIR, port });
  await server.start();

  // Tell each phone what it's looking at.
  server.broadcast({ type: "meta", file: source.label });
  p.log.success(
    `Streaming ${pc.cyan(source.label)} → ${pc.bold(String(server.clientCount))} client(s)`,
  );

  p.note(
    `${pc.cyan(url)}\n\nScan the QR code below with your phone camera.`,
    "Server ready",
  );
  console.log();
  renderQr(url);
  console.log();

  // For a live PTY shell we take over the terminal *after* the QR is shown — a
  // spawned shell clears the screen on start, so we wait for the user to scan
  // first, otherwise the QR would be wiped instantly.
  if (source.takesTerminal) {
    p.log.info(
      pc.dim("Scan the QR, then press Enter to start the shared terminal."),
    );
    await waitForEnter();
    p.log.info(
      pc.dim("Type in this terminal — your phone sees it live. `exit` to stop."),
    );
  } else {
    p.log.info(pc.dim("Press Ctrl+C to stop streaming."));
  }

  // Begin producing lines and pipe them into the broadcast layer.
  // PTY mode streams raw chunks (prompts have no newline) so the phone's
  // terminal emulator renders them instantly; other sources are line-based,
  // so we re-append the newline they were split on.
  const appendNewline = !source.raw;

  // Live terminals report their true size so the phone can render wide TUIs
  // at full width (scaled down) instead of wrapping and breaking box-drawing.
  if (source.takesTerminal) {
    source.instance.onSize = (cols, rows) =>
      server.broadcast({ type: "size", cols, rows });
  }

  await source.instance.start((chunk) =>
    server.broadcast({
      type: "line",
      text: appendNewline ? chunk + "\n" : chunk,
    }),
  );

  const shutdown = (signal: string) => {
    p.outro(`${pc.yellow("Received " + signal)} — stopping share-term.`);
    restoreTerminal();
    source.instance.stop();
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/** Block until the user presses Enter (used to let them scan the QR first). */
function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    rl.question("", () => {
      rl.close();
      resolve();
    });
  });
}

/**
 * Decide what to stream. If stdin is piped we skip the menu and go straight
 * to Pipe Mode; otherwise present the searchable TUI.
 */
async function chooseSource(
  cwd: string,
): Promise<{ instance: LogSource; label: string; takesTerminal?: boolean; raw?: boolean }> {
  // Auto-detect piping: `some-command | share-term`
  if (!process.stdin.isTTY) {
    p.log.info("stdin is piped — entering Manual Input (Pipe) mode.");
    return { instance: new StdinSource(), label: "stdin (pipe)" };
  }

  const spinner = p.spinner();
  spinner.start("Looking for active terminal sessions…");
  const sessions = await findTerminalSessions();
  // Only scan log files when no terminal sessions are available.
  const logs = sessions.length ? [] : await findLogFiles(cwd);
  spinner.stop(
    sessions.length
      ? `Found ${sessions.length} active terminal session(s)`
      : `No terminal sessions — found ${logs.length} log file(s)`,
  );

  const items: Array<{
    value: string;
    name: string;
    description?: string;
  }> = [
    {
      value: "pty:new",
      name: "Live terminal (PTY) — no tmux needed",
      description: "spawn a shared shell right here",
    },
    ...sessions.map((s) => ({
      value: `tmux:${s.target}`,
      name: s.label,
      description: s.hint,
    })),
    {
      value: PIPE_VALUE,
      name: "Manual Input (Pipe Mode)",
      description: "stream from stdin, e.g. `npm run dev | share-term`",
    },
    ...logs.map((f) => ({
      value: `log:${f}`,
      name: path.relative(cwd, f),
      description: "log file",
    })),
  ];

  if (items.length === 1) {
    p.log.warn("No terminal sessions or log files found. Using Pipe Mode.");
    return { instance: new StdinSource(), label: "stdin (pipe)" };
  }

  let selected: string;
  try {
    selected = await search({
      message: "Search a source to share:",
      pageSize: 12,
      source: async (input) => {
        const q = (input ?? "").toLowerCase();
        if (!q) return items;
        return items.filter(
          (i) =>
            i.name.toLowerCase().includes(q) ||
            (i.description ?? "").toLowerCase().includes(q),
        );
      },
    });
  } catch (err) {
    if ((err as { name?: string })?.name === "ExitPromptError") {
      p.cancel("Aborted.");
      process.exit(0);
    }
    throw err;
  }

  if (selected === "pty:new") {
    return {
      instance: new PtySource(),
      label: "live terminal",
      takesTerminal: true,
      raw: true,
    };
  }

  if (selected === PIPE_VALUE) {
    return { instance: new StdinSource(), label: "stdin (pipe)" };
  }

  if (selected.startsWith("tmux:")) {
    const target = selected.slice("tmux:".length);
    const session = sessions.find((s) => s.target === target);
    return {
      instance: new TmuxSessionSource(target),
      label: `terminal ${session?.label ?? target}`,
    };
  }

  const file = selected.slice("log:".length);
  return { instance: new FileTailer(file), label: path.relative(cwd, file) };
}

main().catch((err) => {
  p.log.error(pc.red(String(err?.stack ?? err)));
  process.exit(1);
});
