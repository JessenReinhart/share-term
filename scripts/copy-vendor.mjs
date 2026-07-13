// Copies the xterm.js UMD bundles from node_modules into public/vendor so the
// phone app can load them with no CDN dependency. Run as part of `npm run build`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendor = path.join(root, "public", "vendor");
fs.mkdirSync(vendor, { recursive: true });

const files = [
  ["@xterm/xterm/lib/xterm.js", "xterm.js"],
  ["@xterm/xterm/css/xterm.css", "xterm.css"],
  ["@xterm/addon-fit/lib/addon-fit.js", "addon-fit.js"],
];

for (const [src, dest] of files) {
  const from = path.join(root, "node_modules", src);
  fs.copyFileSync(from, path.join(vendor, dest));
}
console.log("Vendored xterm.js + addon-fit into public/vendor");
