type JsonObject = Record<string, unknown>;

export const ZEROG_ROUTER_TIMEOUT_MS = 30_000;

export interface ZeroGPrivateCompletion {
  response: JsonObject;
  responseText: string;
  chatId: string;
}

export interface ZeroGPrivateCompletionInput {
  apiKey: string;
  baseUrl: string;
  request: JsonObject;
}

export interface ZeroGPrivateCompletionClient {
  complete(
    input: ZeroGPrivateCompletionInput,
  ): Promise<ZeroGPrivateCompletion>;
}

function parseRouterError(body: string, status: number): Error {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return new Error(
      `0G Router returned ${status}: ${parsed.error?.message ?? body}`,
    );
  } catch {
    return new Error(`0G Router returned ${status}: ${body || "unknown error"}`);
  }
}

function resolveProofChatId(
  response: Response,
  responseId: unknown,
): string | undefined {
  const responseKey =
    response.headers.get("ZG-Res-Key") ??
    response.headers.get("zg-res-key");
  if (responseKey) return responseKey;
  if (typeof responseId !== "string") return undefined;
  return responseId.startsWith("chatcmpl-")
    ? responseId.slice("chatcmpl-".length)
    : responseId;
}

export class ZeroGPrivateRouterClient
  implements ZeroGPrivateCompletionClient
{
  constructor(
    private readonly timeoutMs = ZEROG_ROUTER_TIMEOUT_MS,
  ) {}

  async complete({
    apiKey,
    baseUrl,
    request,
  }: ZeroGPrivateCompletionInput): Promise<ZeroGPrivateCompletion> {
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(),
      this.timeoutMs,
    );

    let response: Response;
    let responseText: string;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-0G-Provider-Sort": "latency",
          "X-0G-Provider-Trust-Mode": "private",
        },
        body: JSON.stringify({
          ...request,
          verify_tee: true,
        }),
        signal: timeoutController.signal,
      });
      responseText = await response.text();
    } catch (error) {
      if (timeoutController.signal.aborted) {
        throw new Error(
          `0G private inference timed out after ${this.timeoutMs / 1_000} seconds. No response was received from the Router; retry later or check private provider availability.`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) throw parseRouterError(responseText, response.status);

    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      throw new Error("0G Router returned a non-JSON response.");
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error("0G Router returned an invalid response object.");
    }

    const responseObject = parsed as JsonObject;
    const chatId = resolveProofChatId(response, responseObject.id);
    if (!chatId) {
      throw new Error(
        "0G returned no ZG-Res-Key or response ID for independent TEE verification.",
      );
    }

    return {
      response: responseObject,
      responseText,
      chatId,
    };
  }
}
