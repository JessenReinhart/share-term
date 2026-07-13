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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

const PIPE_VALUE = "__pipe__";

async function main(): Promise<void> {
  p.intro(pc.bgBlue(pc.white(" share-term ")) + pc.dim("  v1.0.0"));

  const cwd = process.cwd();
  const source = await chooseSource(cwd);

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

  // Begin producing lines and pipe them into the broadcast layer.
  await source.instance.start((line) =>
    server.broadcast({ type: "line", text: line }),
  );

  p.note(
    `${pc.cyan(url)}\n\nScan the QR code below with your phone camera.`,
    "Server ready",
  );
  console.log();
  renderQr(url);
  console.log();
  p.log.info(pc.dim("Press Ctrl+C to stop streaming."));

  const shutdown = (signal: string) => {
    p.outro(`${pc.yellow("Received " + signal)} — stopping share-term.`);
    source.instance.stop();
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/**
 * Decide what to stream. If stdin is piped we skip the menu and go straight
 * to Pipe Mode; otherwise present the searchable TUI.
 */
async function chooseSource(
  cwd: string,
): Promise<{ instance: LogSource; label: string }> {
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
      message: sessions.length
        ? "Search an active terminal session to share:"
        : "Search a source to share:",
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
