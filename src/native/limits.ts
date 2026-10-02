export interface NativeLimits {
  apiTimeoutMs: number;
  downloadTimeoutMs: number;
  extractTimeoutMs: number;
  maxArchiveBytes: number;
  maxExecutableBytes: number;
  maxExpandedBytes: number;
}

export function nativeLimits(env: NodeJS.ProcessEnv = process.env): NativeLimits {
  const read = (suffix: string, fallback: number): number => {
    const name = `RELEASEWAY_NATIVE_${suffix}`;
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
    }
    return value;
  };
  return {
    apiTimeoutMs: read("API_TIMEOUT_MS", 30_000),
    downloadTimeoutMs: read("DOWNLOAD_TIMEOUT_MS", 240_000),
    extractTimeoutMs: read("EXTRACT_TIMEOUT_MS", 120_000),
    maxArchiveBytes: read("MAX_ARCHIVE_BYTES", 1024 ** 3),
    maxExecutableBytes: read("MAX_EXECUTABLE_BYTES", 1024 ** 3),
    maxExpandedBytes: read("MAX_EXPANDED_BYTES", 4 * 1024 ** 3),
  };
}

export async function withDeadline<T>(
  label: string,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    const deadline = performance.now() + timeoutMs;
    const expire = () => {
      const remaining = deadline - performance.now();
      if (remaining > 0) {
        timer = setTimeout(expire, Math.min(Math.ceil(remaining), 2 ** 31 - 1));
        return;
      }
      const error = new Error(`${label} exceeded ${timeoutMs}ms preparation budget`);
      controller.abort(error);
      reject(error);
    };
    expire();
  });
  try {
    return await Promise.race([operation(controller.signal), expired]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await consumeBoundedResponse(response, maxBytes, signal, async (chunk) => {
    chunks.push(Buffer.from(chunk));
  });
  return Buffer.concat(chunks);
}

export async function consumeBoundedResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  consume: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Download exceeds ${maxBytes} byte limit`);
  }
  if (!response.body) return;
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  let total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`Download exceeds ${maxBytes} byte limit`);
      await consume(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
