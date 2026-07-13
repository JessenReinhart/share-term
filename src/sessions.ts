import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { promisify } from "node:util";

import { FileTailer, type LogSource } from "./watcher.js";

const execFileP = promisify(execFile);
const EXEC_OPTS: ExecFileOptionsWithStringEncoding = {
  timeout: 5000,
  windowsHide: true,
  encoding: "utf8",
};

/**
 * Run a tmux command. Native tmux binaries (POSIX/WSL) execute directly; a
 * Windows `tmux.cmd`/`.bat` shim must be launched via the shell. We decide per
 * call so we never pass user-controlled args through a shell on real tmux.
 */
function tmuxExec(
  bin: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const isScript = /\.(cmd|bat|com)$/i.test(bin);
  return execFileP(bin, args, { ...EXEC_OPTS, shell: isScript });
}

/**
 * Locate the `tmux` binary once. `execFile` does not apply PATHEXT on Windows,
 * so a Git-Bash/WSL `tmux.cmd` shim would not resolve by name — we walk PATH
 * ourselves checking each PATHEXT extension and cache the first hit.
 * Returns `null` when tmux is not installed / not on PATH.
 */
let tmuxBin: string | null | undefined;
function resolveTmux(): string | null {
  if (tmuxBin !== undefined) return tmuxBin;
  const pathEnv = process.env.PATH ?? "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.trim()).filter(Boolean)
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `tmux${ext}`);
      try {
        if (fs.existsSync(candidate)) {
          tmuxBin = candidate;
          return tmuxBin;
        }
      } catch {
        /* ignore inaccessible dirs */
      }
    }
  }
  tmuxBin = null;
  return tmuxBin;
}

/**
 * A single shareable terminal session.
 *
 * The only cross-platform way to *capture a live terminal's output* without
 * instrumenting every program is a terminal multiplexer. `tmux` is the
 * de-facto standard (native on macOS/Linux, available via WSL or Git-Bash on
 * Windows). We treat each tmux pane as an "active terminal session".
 *
 * If `tmux` is not installed, or no server is running, detection returns an
 * empty list and the CLI falls back to log files / pipe mode.
 */
export interface TerminalSession {
  /** Stable tmux target, e.g. `%3` (pane id). */
  target: string;
  /** Human readable label, e.g. `myapp:1.0 (this pane)`. */
  label: string;
  /** Extra detail shown next to the option. */
  hint?: string;
}

/**
 * Detect active tmux panes and expose them as shareable sessions.
 * Returns `[]` when tmux is unavailable or there are no running sessions.
 */
export async function findTerminalSessions(): Promise<TerminalSession[]> {
  const bin = resolveTmux();
  if (!bin) return [];
  try {
    const { stdout } = await tmuxExec(bin, [
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_current_command}",
    ]);

    const currentPane = process.env.TMUX_PANE; // set when *we* run inside tmux
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id, name, cmd] = line.split("\t");
        const isCurrent = id === currentPane;
        return {
          target: id,
          label: isCurrent ? `${name} (this pane)` : name,
          hint: `tmux · ${cmd || "shell"}`,
        } satisfies TerminalSession;
      });
  } catch {
    return [];
  }
}

/**
 * Streams a live tmux pane to the phone:
 *  - Replays the current pane content (with ANSI colors) on connect.
 *  - Attaches a `pipe-pane` sink that appends all *future* output to a temp
 *    file, which we tail with the existing {@link FileTailer} (low CPU).
 *  - Tears the sink down and removes the temp file on stop.
 */
export class TmuxSessionSource implements LogSource {
  private tmpFile?: string;
  private tailer?: FileTailer;

  constructor(private readonly target: string) {}

  async start(onLine: (line: string) => void): Promise<void> {
    const bin = resolveTmux();
    if (!bin) {
      // Should not happen (we only create this source from a detected pane),
      // but guard against it so the stream fails gracefully.
      console.warn("tmux is no longer available; cannot stream this session.");
      return;
    }
    const tmp = path.join(os.tmpdir(), `share-term-${process.pid}-${Date.now()}.log`);
    fs.writeFileSync(tmp, "");
    this.tmpFile = tmp;

    // Replay what's already on screen (with escape sequences for color).
    try {
      const { stdout } = await tmuxExec(bin, [
        "capture-pane",
        "-p",
        "-e",
        "-J",
        "-t",
        this.target,
      ]);
      for (const line of stdout.split("\n")) onLine(line);
    } catch {
      /* Pane may have vanished; we'll still stream live output if any. */
    }

    // Stream future output into the temp file.
    try {
      await tmuxExec(bin, [
        "pipe-pane",
        "-o",
        "-t",
        this.target,
        `cat >> "${tmp}"`,
      ]);
    } catch {
      /* pipe-pane unsupported / already attached; FileTailer still replays. */
    }

    this.tailer = new FileTailer(tmp);
    await this.tailer.start(onLine);
  }

  stop(): void {
    // Detach the pipe sink (no command = disable).
    try {
      const bin = tmuxBin;
      if (bin)
        execFileSync(bin, ["pipe-pane", "-o", "-t", this.target], {
          ...EXEC_OPTS,
          shell: /\.(cmd|bat|com)$/i.test(bin),
        });
    } catch {
      /* ignore — tmux may already be gone */
    }
    this.tailer?.stop();
    if (this.tmpFile) {
      try {
        fs.unlinkSync(this.tmpFile);
      } catch {
        /* ignore */
      }
    }
  }
}
