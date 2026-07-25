import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const textEncoder = new TextEncoder();

export function sha256Hex(value: string): string {
  return bytesToHex(sha256(textEncoder.encode(value)));
}

export function sha256Bytes(value: Uint8Array): Uint8Array {
  return sha256(value);
}
