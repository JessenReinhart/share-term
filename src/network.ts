import os from "node:os";

/**
 * Find the first non-internal IPv4 address on the machine.
 *
 * We explicitly skip `127.0.0.1` / loopback and any internal (virtual) adapters
 * because a phone needs to reach the laptop over the real LAN/Wi-Fi subnet.
 *
 * @returns the local IPv4 address, or `null` if none could be found.
 */
export function getLocalIp(): string | null {
  const interfaces = os.networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      // family is typed as string on some Node versions and number on others.
      const isIpv4 =
        iface.family === "IPv4" || (iface.family as unknown as number) === 4;
      if (isIpv4 && !iface.internal) {
        return iface.address;
      }
    }
  }

  return null;
}
