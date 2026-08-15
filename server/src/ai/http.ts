import { AiError } from "./provider.js";

export interface RequestJsonArgs {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

export interface JsonResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

/**
 * The transport seam every adapter is constructed with. Production passes
 * `requestJson`; tests pass a recorder that returns a fixture, which is how the
 * adapter suites assert on request shape without a network.
 */
export type RequestJson = (args: RequestJsonArgs) => Promise<JsonResponse>;

/** The hostname, so the failure message names something without echoing a key. */
function vendorOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "the provider";
  }
}

/**
 * JSON in, JSON out, with a per-call timeout. Never throws on a non-2xx status —
 * the caller's `mapError` owns that. Logs nothing: not the url, not the headers,
 * not the body, because every one of those can carry the plaintext API key.
 */
export async function requestJson(args: RequestJsonArgs): Promise<JsonResponse> {
  const res = await fetch(args.url, {
    method: args.method,
    headers: args.headers,
    body: args.body === undefined ? undefined : JSON.stringify(args.body),
    signal: AbortSignal.timeout(args.timeoutMs),
  }).catch((err: unknown) => {
    // A rejected fetch is a network failure, a DNS failure or a TimeoutError.
    // All three are the same thing to a caller: the vendor was unreachable.
    throw new AiError("provider_error", `could not reach ${vendorOf(args.url)}`, {
      cause: err,
    });
  });

  const text = await res.text().catch(() => "");
  let body: unknown = null;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      // A vendor 5xx is often an HTML error page. Hand it back as-is and let
      // mapError decide; parsing is not this layer's problem.
      body = text;
    }
  }
  return { status: res.status, headers: res.headers, body };
}
