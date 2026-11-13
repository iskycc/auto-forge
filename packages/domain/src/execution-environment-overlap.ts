/** Compare address identities, never substring containment or live DNS resolution. */
export function overlappingEnvironmentAddresses(
  requested: readonly string[],
  occupied: readonly string[],
): string[] {
  const occupiedKeys = new Set(occupied.map(environmentAddressKey));
  return [
    ...new Set(requested.filter((address) => occupiedKeys.has(environmentAddressKey(address)))),
  ];
}

/** The full environment pool must match; address order and equivalent IP spellings do not matter. */
export function sameEnvironmentAddresses(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const leftKeys = new Set(left.map(environmentAddressKey));
  const rightKeys = new Set(right.map(environmentAddressKey));
  return leftKeys.size === rightKeys.size && [...leftKeys].every((key) => rightKeys.has(key));
}

function environmentAddressKey(address: string): string {
  const value = address.trim().toLowerCase();
  const ipv6Url = `http://[${value.replace(/^\[|\]$/g, "")}]/`;
  if (!URL.canParse(ipv6Url)) return value;
  const canonical = new URL(ipv6Url).hostname.slice(1, -1);
  // An IPv4-mapped IPv6 address reaches the same environment as its IPv4 form.
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = Number.parseInt(mapped[1]!, 16);
  const low = Number.parseInt(mapped[2]!, 16);
  return [high >>> 8, high & 255, low >>> 8, low & 255].join(".");
}
