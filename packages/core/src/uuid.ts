/**
 * UUID v7 (RFC 9562) without a runtime-specific API, so the same code runs on Node and Bun.
 * Ids made in one process within the same millisecond stay in creation order: the 12 random
 * bits after the timestamp act as a counter until the clock moves on.
 */
let lastMs = 0;
let counter = 0;

export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  if (now > lastMs) {
    lastMs = now;
    counter = (((bytes[6] as number) & 0x07) << 8) | (bytes[7] as number);
  } else {
    now = lastMs;
    counter = (counter + 1) & 0x0fff;
    if (counter === 0) {
      lastMs = now = lastMs + 1;
    }
  }
  bytes[0] = Math.floor(now / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(now / 2 ** 32) & 0xff;
  bytes[2] = (now >>> 24) & 0xff;
  bytes[3] = (now >>> 16) & 0xff;
  bytes[4] = (now >>> 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes[6] = 0x70 | (counter >>> 8);
  bytes[7] = counter & 0xff;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
