import { NextResponse } from "next/server";
import {
  LocalDemoRequestError,
  assertLocalDemoRequest,
} from "@/src/server/local-demo-request";
import { hostedWorldIdentity } from "@/src/server/hosted-world-identity";

const RELAY_URL = "https://x402-worldchain.vercel.app/register";

/**
 * Forward a completed AgentBook registration (World ID proof included) to
 * the canonical relay. Server-side to sidestep browser CORS; carries no
 * secrets — the proof was produced by the human's World App and is bound to
 * the agent address and nonce.
 */
export async function POST(request: Request) {
  try {
    assertLocalDemoRequest(request, { mutating: true });
    const registration = (await request.json()) as Record<string, unknown>;
    const sharedIdentity = hostedWorldIdentity();
    if (sharedIdentity) {
      if (!sharedIdentity.address) {
        throw new Error("The hosted World identity key is not configured.");
      }
      if (
        typeof registration.agent !== "string" ||
        registration.agent.toLowerCase() !==
          sharedIdentity.address.toLowerCase()
      ) {
        throw new LocalDemoRequestError(
          "Hosted registration must target the shared demo identity.",
        );
      }
    }
    const response = await fetch(RELAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registration),
    });
    const body = await response.text();
    if (!response.ok) {
      return NextResponse.json(
        { error: `Relay ${response.status}: ${body.slice(0, 300)}` },
        { status: 502 },
      );
    }
    return NextResponse.json(JSON.parse(body));
  } catch (error) {
    const status = error instanceof LocalDemoRequestError ? error.status : 400;
    const message =
      error instanceof Error ? error.message : "Registration failed.";
    return NextResponse.json({ error: message }, { status });
  }
}
