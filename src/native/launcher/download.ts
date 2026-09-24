import { createHash, timingSafeEqual } from "node:crypto";

type FetchLike = typeof fetch;

function encodeRepository(repository: string): string {
  const parts = repository.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid GitHub repository identity: ${repository}`);
  }
  return parts.map(encodeURIComponent).join("/");
}

export function releaseAssetUrl(
  repository: string,
  tag: string,
  asset: string,
): string {
  return `https://github.com/${encodeRepository(repository)}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
}

export function verifySha256(
  bytes: Uint8Array,
  expectedHex: string,
): void {
  if (!/^[0-9a-f]{64}$/i.test(expectedHex)) {
    throw new Error("Expected native asset SHA-256 must be 64 hexadecimal characters");
  }
  const expected = Buffer.from(expectedHex, "hex");
  const actual = createHash("sha256").update(bytes).digest();
  if (!timingSafeEqual(expected, actual)) {
    throw new Error("Native asset SHA-256 digest mismatch");
  }
}

export async function downloadReleaseAsset(
  repository: string,
  tag: string,
  asset: string,
  fetchImpl: FetchLike = fetch,
): Promise<Buffer> {
  const response = await fetchImpl(releaseAssetUrl(repository, tag, asset), {
    redirect: "follow",
    headers: {
      "User-Agent": "releaseway-npm-actions-native",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to download native GitHub Release asset ${asset}: HTTP ${response.status}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}
