const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export class LocalDemoRequestError extends Error {
  readonly status = 403;
}

/**
 * The Hedera operator key is intentionally a local demo credential. Keep the
 * spending API bound to the machine running Next unless the operator makes an
 * explicit deployment decision, and reject cross-origin browser requests.
 */
export function assertLocalDemoRequest(
  request: Request,
  options: { mutating?: boolean } = {},
): void {
  const url = new URL(request.url);
  if (
    process.env.HEDERA_ALLOW_REMOTE !== "true" &&
    !LOOPBACK_HOSTS.has(url.hostname)
  ) {
    throw new LocalDemoRequestError(
      "Hedera settlement is local-only. Run the demo on localhost or explicitly set HEDERA_ALLOW_REMOTE=true.",
    );
  }

  const origin = request.headers.get("origin");
  if (origin) {
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      throw new LocalDemoRequestError("Invalid request origin.");
    }
    if (originUrl.origin !== url.origin) {
      throw new LocalDemoRequestError(
        "Cross-origin Hedera settlement requests are not allowed.",
      );
    }
  }

  if (
    options.mutating &&
    request.headers.get("x-pastel-local-demo") !== "1"
  ) {
    throw new LocalDemoRequestError(
      "Missing the local-demo request marker.",
    );
  }
}
