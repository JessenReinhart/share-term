#!/usr/bin/env node
/**
 * share-term — stream your terminal logs to your phone via QR code.
 *
 * Flow:
 *   1. Scan cwd for *.log files (node_modules etc. excluded).
 *   2. Show a TUI wizard (clack) to pick a file or "Pipe Mode".
 *   3. Start an HTTP + WebSocket server, detect LAN IP, render a QR code.
 *   4. Tail the selected source and broadcast new lines to connected phones.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import * as p from "@clack/prompts";
import pc from "picocolors";
import getPort from "get-port";

import { getLocalIp } from "./network.js";
import { renderQr } from "./qr.js";
import { ShareServer } from "./server.js";
import {
  FileTailer,
  StdinSource,
  findLogFiles,
  type LogSource,
} from "./watcher.js";

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
 * to Pipe Mode; otherwise present the interactive TUI.
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
  spinner.start("Scanning for log files…");
  const logs = await findLogFiles(cwd);
  spinner.stop(`Found ${logs.length} log file(s)`);

  const options: Array<{ value: string; label: string; hint?: string }> =
    logs.map((f) => ({
      value: f,
      label: path.relative(cwd, f),
    }));

  options.unshift({
    value: PIPE_VALUE,
    label: pc.cyan("Manual Input (Pipe Mode)"),
    hint: "stream from stdin, e.g. `npm run dev | share-term`",
  });

  if (options.length === 1) {
    p.log.warn("No .log files found. Falling back to Pipe Mode.");
    return { instance: new StdinSource(), label: "stdin (pipe)" };
  }

  const selected = await p.select({
    message: "What would you like to stream to your phone?",
    options,
    initialValue: options[1]?.value,
  });

  if (p.isCancel(selected)) {
    p.cancel("Aborted.");
    process.exit(0);
  }

  if (selected === PIPE_VALUE) {
    return { instance: new StdinSource(), label: "stdin (pipe)" };
  }

  const file = selected as string;
  return { instance: new FileTailer(file), label: path.relative(cwd, file) };
}

main().catch((err) => {
  p.log.error(pc.red(String(err?.stack ?? err)));
  process.exit(1);
});
