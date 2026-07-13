import process from "node:process";
import * as pty from "node-pty";

import type { LogSource } from "./watcher.js";

export interface PtyOptions {
  /** Shell to spawn. Defaults to `$SHELL` / `$ComSpec`. */
  shell?: string;
  /** Extra args passed to the shell (e.g. `["-c", "echo hi"]`). */
  args?: string[];
  /** Command to run inside the PTY instead of an interactive shell
   *  (e.g. `npm run dev`). Spawned as `<shell> -c "<command>"`. */
  command?: string;
}

function defaultShell(): string {
  if (process.platform === "win32") return process.env.ComSpec ?? "cmd.exe";
  return process.env.SHELL ?? "/bin/bash";
}

/**
 * Shares a *live, interactive terminal* without requiring `tmux`.
 *
 * We spawn the user's shell inside a PTY (pseudo-terminal) via `node-pty`
 * (ConPTY on Windows, openpty on POSIX). Everything the shell prints is:
 *   - mirrored straight to the laptop terminal so the user keeps using it, and
 *   - split into complete lines (ANSI escapes kept intact) and handed to the
 *     phone over the existing broadcast channel.
 *
 * The laptop's own keystrokes are forwarded into the PTY, so typing in the
 * terminal drives the shared shell. Exiting the shell (`exit`) stops sharing.
 */
export class PtySource implements LogSource {
  private proc?: pty.IPty;

  constructor(private readonly opts: PtyOptions = {}) {}

  async start(onLine: (line: string) => void): Promise<void> {
    const shell = this.opts.shell ?? defaultShell();
    const args = this.opts.command
      ? process.platform === "win32"
        ? ["/c", this.opts.command]
        : ["-c", this.opts.command]
      : this.opts.args ?? [];
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;

    this.proc = pty.spawn(shell, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.cwd(),
      env: process.env,
    });

    this.proc.onData((data: string) => {
      // Mirror to the laptop so the user still sees their live shell.
      if (process.stdout.writable) process.stdout.write(data);

      // Forward the raw chunk unchanged. The phone renders a real terminal
      // emulator, so cursor moves / prompts (which have no trailing newline)
      // must be streamed as-is to appear instantly.
      onLine(data);
    });

    // When the shell exits, tear everything down.
    this.proc.onExit(() => {
      this.stop();
      process.exit(0);
    });

    // Forward laptop keystrokes into the shell (only when we own a TTY).
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", (chunk: Buffer) => {
        this.proc?.write(chunk.toString("utf8"));
      });
      process.stdout.on("resize", () => {
        this.proc?.resize(
          process.stdout.columns ?? 80,
          process.stdout.rows ?? 24,
        );
      });
    }
  }

  stop(): void {
    // Turn off any input-reporting modes and restore the cursor so the
    // terminal isn't left dirty after the shared shell exits.
    if (process.stdout.isTTY) {
      try {
        process.stdout.write(
          "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[0m",
        );
      } catch {
        /* ignore */
      }
    }
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
      try {
        process.stdin.pause();
      } catch {
        /* ignore */
      }
    }
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.proc = undefined;
  }
}
