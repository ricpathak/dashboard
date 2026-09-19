import { sha256 } from "@noble/hashes/sha256";
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function fingerprint(text: string): string {
  return Array.from(sha256(new TextEncoder().encode(text)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
