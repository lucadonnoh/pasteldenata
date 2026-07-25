import {
  ZeroGPrivateRouterClient,
  type ZeroGPrivateCompletionClient,
} from "./zerog-private";

export const ZEROG_READINESS_MODEL = "0gm-1.0-35b-a3b";

interface RouterReadinessResponse {
  x_0g_trace?: {
    request_id?: string;
    provider?: string;
    tee_verified?: boolean;
  };
}

/**
 * Explicitly bill one output token on the same private TeeML route used by the
 * planner. A generic Router success is not readiness: private routing and the
 * Router's synchronous TEE verification must both succeed.
 */
export async function verifyZeroGPrivateReadiness(
  apiKey: string,
  client: ZeroGPrivateCompletionClient =
    new ZeroGPrivateRouterClient(20_000),
): Promise<void> {
  const completion = await client.complete({
    apiKey,
    baseUrl: "https://router-api.0g.ai/v1",
    request: {
      model: ZEROG_READINESS_MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "readiness" }],
    },
  });
  const trace = (completion.response as RouterReadinessResponse).x_0g_trace;
  if (
    trace?.tee_verified !== true ||
    !trace.request_id ||
    !trace.provider
  ) {
    throw new Error(
      "0G private readiness returned no verified TeeML trace.",
    );
  }
}

export function zeroGReadinessErrorMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "0G readiness failed.";
  if (/returned 402/.test(message)) {
    return "Router balance empty — top up at pc.0g.ai";
  }
  if (/returned 401/.test(message)) {
    return "Key rejected by the 0G Router";
  }
  if (/timed out/i.test(message)) {
    return "The private TeeML route timed out.";
  }
  if (/no_provider_for_trust_mode/i.test(message)) {
    return "No private TeeML provider is currently available.";
  }
  return message;
}
