export interface Finished {
  /** Milliseconds from `startedAt` until the body finished or was cancelled. */
  totalMs: number;
  tokens: number | null;
  error: string | null;
  /** Whole body when it was a small JSON response that completed cleanly; otherwise null. */
  body: Buffer | null;
}

const CAPTURE_LIMIT = 256 * 1024;

/**
 * Passes the response body through untouched while measuring when it ends, and (for small JSON bodies)
 * reading `usage.total_tokens`. `onDone` runs exactly once: on completion, client abort or stream error.
 */
export function observeResponse(res: Response, startedAt: number, onDone: (f: Finished) => void): Response {
  const status = res.status;
  let finished = false;
  const finish = (error: string | null, chunks: Uint8Array[] | null) => {
    if (finished) return;
    finished = true;
    let tokens: number | null = null;
    const whole = chunks && chunks.length > 0 && !error ? Buffer.concat(chunks) : null;
    if (whole) {
      try {
        const json = JSON.parse(whole.toString('utf8')) as { usage?: { total_tokens?: unknown } };
        const t = json?.usage?.total_tokens;
        if (typeof t === 'number' && t > 0) tokens = t;
      } catch {
        // not JSON / truncated: no token count
      }
    }
    onDone({ totalMs: performance.now() - startedAt, tokens, error: error ?? (status >= 400 ? `http_${status}` : null), body: whole });
  };

  if (!res.body) {
    finish(null, null);
    return res;
  }

  const isJson = res.headers.get('content-type')?.includes('application/json') ?? false;
  let chunks: Uint8Array[] | null = isJson ? [] : null;
  let size = 0;
  const reader = res.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish(null, chunks);
          controller.close();
          return;
        }
        if (chunks) {
          size += value.length;
          if (size > CAPTURE_LIMIT) chunks = null;
          else chunks.push(value);
        }
        controller.enqueue(value);
      } catch (err) {
        finish('stream_error', null);
        controller.error(err);
      }
    },
    cancel(reason) {
      finish('client_aborted', null);
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status, statusText: res.statusText, headers: res.headers });
}
