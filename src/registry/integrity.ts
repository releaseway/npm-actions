import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";

export async function sha512Integrity(path: string): Promise<string> {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return "sha512-" + hash.digest("base64");
}

function decodeSha512(token: string): Buffer | undefined {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(token);
  if (!match) {
    return undefined;
  }

  const decoded = Buffer.from(match[1], "base64");
  return decoded.length === 64 ? decoded : undefined;
}

export function integrityContainsExactSha512(
  remoteIntegrity: string,
  expectedIntegrity: string,
): boolean {
  const expected = decodeSha512(expectedIntegrity);
  if (!expected) {
    throw new Error("Expected artifact integrity must be SHA-512 SRI");
  }

  for (const token of remoteIntegrity.trim().split(/\s+/).filter(Boolean)) {
    const candidate = decodeSha512(token);
    if (
      candidate &&
      candidate.length === expected.length &&
      timingSafeEqual(candidate, expected)
    ) {
      return true;
    }
  }

  return false;
}

export function hasValidSha512Integrity(remoteIntegrity: string): boolean {
  return remoteIntegrity
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .some((token) => decodeSha512(token) !== undefined);
}
