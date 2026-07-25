const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export class LocalDemoRequestError extends Error {
  readonly status = 403;
}

/**
 * Keep spending APIs bound to the machine running Next unless the operator
 * makes an explicit deployment decision, and always reject cross-origin
 * browser requests. Hosted mode remains a public demo, not production auth.
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
    const forwardedHost = request.headers
      .get("x-forwarded-host")
      ?.split(",")[0]
      ?.trim();
    const forwardedProto =
      request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
      "https";
    const acceptedOrigins = new Set([
      url.origin,
      ...(forwardedHost ? [`${forwardedProto}://${forwardedHost}`] : []),
    ]);
    if (!acceptedOrigins.has(originUrl.origin)) {
      throw new LocalDemoRequestError(
        "Cross-origin demo requests are not allowed.",
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
