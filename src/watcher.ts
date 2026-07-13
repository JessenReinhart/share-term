import fs from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";

/**
 * A source of log lines. Implementations push complete newline-delimited lines
 * to the `onLine` callback passed to `start()`. The CLI wires this into the
 * WebSocket broadcast layer.
 */
export interface LogSource {
  /** Begin producing lines. Resolves once the source is live. */
  start(onLine: (line: string) => void): Promise<void>;
  /** Stop watching / reading and release resources. */
  stop(): void;
  /** Optional: report the source's terminal size (PTY mode) so the phone
   *  can render at the true width instead of wrapping wide TUIs. */
  onSize?: (cols: number, rows: number) => void;
}

const CHUNK_SIZE = 64 * 1024; // 64 KiB read window for the initial tail.
const INITIAL_TAIL_LINES = 200; // How many historical lines to replay on connect.

/**
 * Tails a file using a `tail -f` equivalent:
 *  - On start, replays the last N lines so the phone isn't blank.
 *  - Watches the file with chokidar and reads only the *appended* bytes on
 *    each change (low CPU, works for large logs).
 *  - Buffers partial trailing lines until a newline arrives.
 *  - Detects truncation/rotation (size shrinks) and restarts from the top.
 */
export class FileTailer implements LogSource {
  private watcher?: FSWatcher;
  private lastSize = 0;
  private buffer = "";
  private onLine: (line: string) => void = () => {};

  constructor(private readonly filePath: string) {}

  async start(onLine: (line: string) => void): Promise<void> {
    this.onLine = onLine;
    await this.replayTail();
    this.watcher = chokidar.watch(this.filePath, { ignoreInitial: true });
    this.watcher.on("change", () => void this.readNew());
    this.watcher.on("error", () => {
      /* Ignore transient FS errors; chokidar will retry. */
    });
  }

  /** Read and emit the last {@link INITIAL_TAIL_LINES} lines of the file. */
  private async replayTail(): Promise<void> {
    try {
      const stat = await fs.promises.stat(this.filePath);
      const size = stat.size;
      const start = Math.max(0, size - CHUNK_SIZE);
      const fd = await fs.promises.open(this.filePath, "r");
      const buf = Buffer.alloc(size - start);
      const { bytesRead } = await fd.read(buf, 0, buf.length, start);
      await fd.close();

      const tail = buf.slice(0, bytesRead).toString("utf8");
      const lines = tail.split("\n").slice(-INITIAL_TAIL_LINES);
      for (const line of lines) {
        if (line.length) this.onLine(line);
      }
      this.lastSize = size;
    } catch {
      // File may not exist yet; we'll pick it up once chokidar sees it.
      this.lastSize = 0;
    }
  }

  /** Read only the bytes appended since the last read. */
  private async readNew(): Promise<void> {
    try {
      const stat = await fs.promises.stat(this.filePath);
      if (stat.size < this.lastSize) {
        // File was truncated/rotated — start over and replay.
        this.lastSize = 0;
        this.buffer = "";
        await this.replayTail();
        return;
      }
      const length = stat.size - this.lastSize;
      if (length <= 0) return;

      const fd = await fs.promises.open(this.filePath, "r");
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fd.read(buf, 0, length, this.lastSize);
      await fd.close();
      this.lastSize = stat.size;

      this.buffer += buf.slice(0, bytesRead).toString("utf8");
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (line.length) this.onLine(line);
      }
    } catch {
      /* File momentarily unavailable; ignore. */
    }
  }

  stop(): void {
    void this.watcher?.close();
    this.watcher = undefined;
  }
}

/**
 * Pipe mode: reads from `process.stdin` and emits each line as it arrives.
 * Useful for `npm run dev | share-term` or `docker logs -f foo | share-term`.
 */
export class StdinSource implements LogSource {
  private buffer = "";

  async start(onLine: (line: string) => void): Promise<void> {
    process.stdin.setEncoding("utf8");

    process.stdin.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        onLine(line);
      }
    });

    process.stdin.on("end", () => {
      if (this.buffer.length) onLine(this.buffer);
    });

    // If nothing is piped (interactive shell), end immediately.
    if (process.stdin.isTTY) {
      process.stdin.pause();
    }
  }

  stop(): void {
    process.stdin.pause();
  }
}

/** Recursively find log files under `cwd`, skipping noisy directories. */
export async function findLogFiles(cwd: string, max = 200): Promise<string[]> {
  const results: string[] = [];
  const exclude = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".cache",
    "coverage",
    ".turbo",
  ]);

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6 || results.length >= max) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Permission error or gone — skip.
    }

    for (const entry of entries) {
      if (entry.name === ".log") {
        // top-level bare ".log" file is valid; handled below
      }
      if (entry.name.startsWith(".") && entry.name !== ".log") continue;

      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (exclude.has(entry.name)) continue;
        await walk(full, depth + 1);
      } else if (entry.isFile() && /\.log$/i.test(entry.name)) {
        results.push(full);
      }
    }
  }

  await walk(cwd, 0);
  return results.sort();
}
