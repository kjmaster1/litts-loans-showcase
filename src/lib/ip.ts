/**
 * Display form of an IP address. Better Auth stores IPv6 fully expanded
 * ("0000:0000:…:0001"); this applies RFC 5952 compression ("::1") and unwraps
 * IPv4-mapped addresses ("::ffff:203.0.113.7" → "203.0.113.7").
 */
export function formatIp(ip: string | null): string | null {
  if (!ip) return null;
  const mapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(":")) return ip;

  let groups: string[];
  if (ip.includes("::")) {
    const [head, tail] = ip.split("::");
    const h = head ? head.split(":") : [];
    const t = tail ? tail.split(":") : [];
    groups = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  } else {
    groups = ip.split(":");
  }
  if (groups.length !== 8) return ip;
  const short = groups.map((g) => g.replace(/^0+(?=.)/, "").toLowerCase());

  // Longest run (length ≥ 2) of zero groups, first one on ties.
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (short[i] !== "0") {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && short[j] === "0") j++;
    if (j - i > bestLen && j - i >= 2) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (bestStart === -1) return short.join(":");
  return `${short.slice(0, bestStart).join(":")}::${short.slice(bestStart + bestLen).join(":")}`;
}
