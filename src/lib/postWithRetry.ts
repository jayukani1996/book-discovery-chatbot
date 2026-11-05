const CONNECT_TIMEOUT_MS = 15000;
const RETRY_DELAY_MS = 500;

/**
 * POST that survives one dropped connection, such as a phone network changing IP.
 * It only retries while waiting for the response to start, so an answer can't be sent twice.
 * The timeout ends once the response starts, and the caller's signal can still cancel the stream.
 */
export async function postWithRetry(url: string, init: RequestInit, fetchImpl: typeof fetch = fetch, connectTimeoutMs = CONNECT_TIMEOUT_MS): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const cancel = () => ctrl.abort();
    init.signal?.addEventListener("abort", cancel);
    const timer = setTimeout(cancel, connectTimeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: ctrl.signal });
    } catch (err) {
      init.signal?.removeEventListener("abort", cancel);
      if (init.signal?.aborted) throw err;
      if (attempt >= 1) throw new TypeError("Network request failed");
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    } finally {
      clearTimeout(timer);
    }
  }
}
