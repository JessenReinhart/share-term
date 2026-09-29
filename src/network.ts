import os from "node:os";

const IGNORED_INTERFACE_PATTERN = /^(tun|tap|utun|vpn|docker|veth|br-|lo)/i;

function isRfc1918(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return false;
  }

  const [b0, b1] = parts;
  if (b0 === 10) return true;
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
  if (b0 === 192 && b1 === 168) return true;
  return false;
}

export function getLocalIp(): string | undefined {
  const interfaces = os.networkInterfaces();
  const candidates: string[] = [];

  for (const [name, ifaceList] of Object.entries(interfaces)) {
    if (!ifaceList || IGNORED_INTERFACE_PATTERN.test(name)) {
      continue;
    }

    for (const iface of ifaceList) {
      const isIpv4 =
        iface.family === "IPv4" || (iface.family as unknown as number) === 4;

      if (!isIpv4 || iface.internal) {
        continue;
      }

      if (isRfc1918(iface.address)) {
        return iface.address;
      }

      candidates.push(iface.address);
    }
  }

  return candidates[0];
}
