import qrcode from "qrcode-terminal";

/**
 * Render a URL as a QR code directly to the terminal using ANSI half-block
 * characters. The `small: true` option keeps it compact so it fits narrow
 * terminal windows while still being scannable by phone cameras.
 */
export function renderQr(url: string): void {
  qrcode.generate(url, { small: true });
}
