const store = globalThis as unknown as {
  __pastelDemoRateLimits?: Map<string, { count: number; resetAt: number }>;
};

const counters = (store.__pastelDemoRateLimits ??= new Map());

export class DemoRateLimitError extends Error {
  readonly status = 429;

  constructor(readonly retryAfterSeconds: number) {
    super(
      `Demo capacity reached. Try again in ${retryAfterSeconds} seconds.`,
    );
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function callerAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return (
    forwarded?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

function consumeCounter(
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): void {
  const current = counters.get(key);
  if (!current || current.resetAt <= now) {
    counters.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  if (current.count >= limit) {
    throw new DemoRateLimitError(
      Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    );
  }
  current.count += 1;
}

/**
 * A public hackathon deployment is intentionally frictionless, so this is an
 * abuse budget rather than user authentication. It protects the shared 0G key
 * and testnet operator from accidental loops and casual draining; a caller
 * able to spoof proxy headers is still inside the documented demo trust limit.
 */
export function consumeHostedDemoCapacity(
  request: Request,
  bucket: "zerog-plan" | "hedera-settlement",
  now = Date.now(),
): void {
  if (process.env.HOSTED_DEMO_MODE !== "true") return;

  const windowMs = 60 * 60 * 1000;
  const perCallerLimit = positiveInteger(
    process.env.DEMO_MAX_RUNS_PER_IP_PER_HOUR,
    10,
  );
  const globalLimit = positiveInteger(
    process.env.DEMO_MAX_RUNS_PER_HOUR,
    30,
  );
  const caller = callerAddress(request);

  consumeCounter(`${bucket}:global`, globalLimit, windowMs, now);
  consumeCounter(`${bucket}:caller:${caller}`, perCallerLimit, windowMs, now);
}
