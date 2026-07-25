"use client";

import { createWorldBridgeStore } from "@worldcoin/idkit-core";
import { solidityEncode } from "@worldcoin/idkit-core/hashing";
import { ExternalLink, KeyRound, ShieldCheck, UserCheck } from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";
import { createPublicClient, decodeAbiParameters, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { worldchain } from "viem/chains";
import {
  freshHostedWorldSessionId,
  hostedWorldDemoChoice,
  hostedWorldReadinessUrl,
  hostedWorldSessionId,
  saveHostedWorldDemoChoice,
  type HostedWorldDemoChoice,
} from "@/src/hosted-world-demo";

const AGENT_BOOK_CONTRACT = "0xA23aB2712eA7BBa896930544C7d6636a96b944dA";
const AGENT_BOOK_ABI = [
  {
    inputs: [{ internalType: "address", name: "", type: "address" }],
    name: "getNextNonce",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "", type: "address" }],
    name: "lookupHuman",
    outputs: [{ internalType: "uint256", name: "humanId", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;
const APP_ID = "app_a7c3e2b6b83927251a0db5345bd7146a";
const ACTION = "agentbook-registration";
const STORAGE_KEY = "pastel-world-identity";
const WORLDSCAN_URL = "https://worldscan.org";

interface StoredIdentity {
  address: `0x${string}`;
  privateKey?: `0x${string}`;
  humanId?: string;
  txHash?: `0x${string}`;
}

interface HostedIdentityOptions {
  verified?: { identityAgent?: `0x${string}`; verified: boolean };
  visitor?: { identityAgent: `0x${string}`; verified: boolean };
}

function loadIdentity(): StoredIdentity | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredIdentity) : null;
  } catch {
    return null;
  }
}

function saveIdentity(
  identity: StoredIdentity & { privateKey: `0x${string}` },
): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
}

function transactionHash(value: unknown): `0x${string}` | undefined {
  return typeof value === "string" && /^0x[a-fA-F0-9]{64}$/.test(value)
    ? (value as `0x${string}`)
    : undefined;
}

function normalizeProof(raw: string): string[] | null {
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed as string[];
    } catch {
      // fall through
    }
  }
  try {
    const decoded = decodeAbiParameters(
      [{ type: "uint256[8]" }],
      raw as `0x${string}`,
    )[0] as readonly bigint[];
    return decoded.map((v) => `0x${v.toString(16).padStart(64, "0")}`);
  } catch {
    return null;
  }
}

type Phase =
  | { name: "idle" }
  | { name: "connecting" }
  | { name: "scan"; qrDataUrl: string; connectorURI: string }
  | { name: "registering" }
  | { name: "registered"; humanId?: string; txHash?: string }
  | { name: "error"; message: string };

/**
 * In-product AgentBook registration: the same flow as the AgentKit CLI —
 * nonce from the AgentBook contract, a World ID bridge session, a QR the
 * human scans with World App, and the signed proof relayed on-chain. The
 * In local mode the identity key never leaves this browser. Hosted mode asks
 * the server for a session-derived public address and never returns its key.
 * In both modes the human's World ID never leaves their phone.
 */
export function WorldVerify() {
  const [identity, setIdentity] = useState<StoredIdentity | null>(null);
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [hostedDemo, setHostedDemo] = useState(false);
  const [hostedChoice, setHostedChoice] =
    useState<HostedWorldDemoChoice>("verified");
  const [hostedSession, setHostedSession] = useState("");
  const [hostedIdentities, setHostedIdentities] =
    useState<HostedIdentityOptions>({});

  const applyHostedIdentity = useCallback(function applyHostedIdentity(
    choice: HostedWorldDemoChoice,
    identities: HostedIdentityOptions,
  ) {
    const selected =
      choice === "verified" ? identities.verified : identities.visitor;
    setHostedChoice(choice);
    saveHostedWorldDemoChoice(choice);
    setIdentity(
      selected?.identityAgent ? { address: selected.identityAgent } : null,
    );
    setPhase(selected?.verified ? { name: "registered" } : { name: "idle" });
  }, []);

  const loadHostedIdentity = useCallback(async function loadHostedIdentity(
    sessionId: string,
    choice: HostedWorldDemoChoice,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const response = await fetch(hostedWorldReadinessUrl(sessionId), {
      cache: "no-store",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return false;
    const readiness = (await response.json()) as {
      world?: {
        mode?: "browser" | "hosted-demo";
        identities?: {
          verified?: {
            identityAgent?: `0x${string}`;
            verified: boolean;
          };
          visitor?: {
            identityAgent: `0x${string}`;
            verified: boolean;
          };
        };
      };
    };
    if (
      readiness.world?.mode !== "hosted-demo" ||
      !readiness.world.identities
    ) {
      return false;
    }
    setHostedDemo(true);
    setHostedSession(sessionId);
    setHostedIdentities(readiness.world.identities);
    applyHostedIdentity(choice, readiness.world.identities);
    return true;
  }, [applyHostedIdentity]);

  useEffect(() => {
    // Defer past the initial effect flush; localStorage is browser-only and
    // the lint rule forbids synchronous setState inside effects.
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const sessionId = hostedWorldSessionId();
        const choice = hostedWorldDemoChoice();
        if (
          await loadHostedIdentity(sessionId, choice, controller.signal)
        ) {
          return;
        }
      } catch (error) {
        if (
          error instanceof DOMException &&
          error.name === "AbortError"
        ) {
          return;
        }
        // Fall back to the local browser identity flow.
      }
      let stored = loadIdentity();
      if (!stored) {
        const privateKey = generatePrivateKey();
        const generated = {
          address: privateKeyToAccount(privateKey).address,
          privateKey,
        };
        saveIdentity(generated);
        stored = generated;
      }
      setIdentity(stored);
      if (stored.humanId) {
        const txHash = transactionHash(stored.txHash);
        setPhase({
          name: "registered",
          humanId: stored.humanId,
          ...(txHash ? { txHash } : {}),
        });
      }
    }, 0);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [loadHostedIdentity]);

  async function verify() {
    if (!identity) return;
    setPhase({ name: "connecting" });
    try {
      const client = createPublicClient({
        chain: worldchain,
        transport: http(),
      });
      const existing = await client.readContract({
        address: AGENT_BOOK_CONTRACT,
        abi: AGENT_BOOK_ABI,
        functionName: "lookupHuman",
        args: [identity.address],
      });
      if (existing !== 0n) {
        const humanId = `0x${existing.toString(16)}`;
        if (!hostedDemo && identity.privateKey) {
          saveIdentity({ ...identity, privateKey: identity.privateKey, humanId });
        }
        const txHash = transactionHash(identity.txHash);
        setPhase({
          name: "registered",
          humanId,
          ...(txHash ? { txHash } : {}),
        });
        if (hostedDemo) {
          setHostedIdentities((current) => ({
            ...current,
            [hostedChoice]: {
              ...(current[hostedChoice] ?? {}),
              identityAgent: identity.address,
              verified: true,
            },
          }));
        }
        return;
      }

      const nonce = await client.readContract({
        address: AGENT_BOOK_CONTRACT,
        abi: AGENT_BOOK_ABI,
        functionName: "getNextNonce",
        args: [identity.address],
      });
      const signal = solidityEncode(
        ["address", "uint256"],
        [identity.address, nonce.toString()],
      );
      const bridge = createWorldBridgeStore();
      await bridge.getState().createClient({
        app_id: APP_ID,
        action: ACTION,
        signal,
      });
      const connectorURI = bridge.getState().connectorURI;
      if (!connectorURI) throw new Error("No World App connector URI.");
      const qrDataUrl = await QRCode.toDataURL(connectorURI, { margin: 1 });
      setPhase({ name: "scan", qrDataUrl, connectorURI });

      const deadline = Date.now() + 300_000;
      for (;;) {
        if (Date.now() > deadline) throw new Error("World App verification timed out.");
        await bridge.getState().pollForUpdates();
        const { result, errorCode } = bridge.getState();
        if (errorCode) throw new Error(`World App: ${errorCode}`);
        if (result) {
          setPhase({ name: "registering" });
          const proof = normalizeProof(result.proof);
          if (!proof) throw new Error("Unexpected proof format from World App.");
          const response = await fetch("/api/world/register", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-pastel-local-demo": "1",
            },
            body: JSON.stringify({
              agent: identity.address,
              root: result.merkle_root,
              nonce: nonce.toString(),
              nullifierHash: result.nullifier_hash,
              proof,
              contract: AGENT_BOOK_CONTRACT,
              ...(hostedDemo
                ? {
                    hostedWorldIdentity:
                      hostedChoice === "visitor"
                        ? {
                            mode: "visitor" as const,
                            sessionId: hostedSession,
                          }
                        : { mode: "verified" as const },
                  }
                : {}),
            }),
          });
          const body = (await response.json()) as {
            txHash?: string;
            error?: string;
          };
          if (!response.ok) throw new Error(body.error ?? "Relay refused.");

          let humanId: string | undefined;
          for (let attempt = 0; attempt < 20 && !humanId; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 3000));
            const onchain = await client.readContract({
              address: AGENT_BOOK_CONTRACT,
              abi: AGENT_BOOK_ABI,
              functionName: "lookupHuman",
              args: [identity.address],
            });
            if (onchain !== 0n) humanId = `0x${onchain.toString(16)}`;
          }
          if (!humanId) {
            throw new Error(
              "Relay accepted the proof but the registration has not appeared on World Chain yet. Retry status in a minute.",
            );
          }
          const txHash = transactionHash(body.txHash);
          if (!hostedDemo && identity.privateKey) {
            saveIdentity({
              ...identity,
              privateKey: identity.privateKey,
              humanId,
              ...(txHash ? { txHash } : {}),
            });
          }
          setPhase({
            name: "registered",
            humanId,
            ...(txHash ? { txHash } : {}),
          });
          if (hostedDemo) {
            setHostedIdentities((current) => ({
              ...current,
              [hostedChoice]: {
                ...(current[hostedChoice] ?? {}),
                identityAgent: identity.address,
                verified: true,
              },
            }));
          }
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      setPhase({
        name: "error",
        message: error instanceof Error ? error.message : "Verification failed.",
      });
    }
  }

  return (
    <section className="world-verify" aria-label="World ID verification">
      <header>
        <span>
          <UserCheck size={16} aria-hidden="true" />
        </span>
        <div>
          <small>WORLD AGENTKIT</small>
          <strong>Human-backed buyer identity</strong>
        </div>
      </header>

      <p>
        {hostedDemo ? (
          <>
            Choose the pre-verified human for the successful path, or a fresh
            visitor to watch protected sellers refuse an unverified bidder.
            The visitor can verify this address without changing what the next
            judge sees.
          </>
        ) : (
          <>
            Scarce listings in this market are <b>one allocation per human</b>.
            Registering links your buyer&apos;s identity agent to your anonymous
            World ID in the AgentBook on World Chain — your agents earn bidding
            rights; sellers only ever see auction-scoped nullifiers.
          </>
        )}
      </p>

      {hostedDemo && (
        <div
          className="world-path-picker"
          role="radiogroup"
          aria-label="World identity demo path"
        >
          <button
            type="button"
            role="radio"
            aria-checked={hostedChoice === "verified"}
            className={hostedChoice === "verified" ? "selected" : ""}
            onClick={() => applyHostedIdentity("verified", hostedIdentities)}
          >
            <UserCheck size={15} aria-hidden="true" />
            <span>
              <b>Already verified</b>
              <small>Happy path · auction passes issued</small>
            </span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={hostedChoice === "visitor"}
            className={hostedChoice === "visitor" ? "selected" : ""}
            onClick={() => applyHostedIdentity("visitor", hostedIdentities)}
          >
            <KeyRound size={15} aria-hidden="true" />
            <span>
              <b>Fresh visitor</b>
              <small>
                {hostedIdentities.visitor?.verified
                  ? "Verified by this visitor"
                  : "Unverified · protected bids refused"}
              </small>
            </span>
          </button>
        </div>
      )}

      <dl>
        <div>
          <dt>
            <KeyRound size={12} aria-hidden="true" /> Identity agent
          </dt>
          <dd>
            <code>{identity?.address ?? "generating…"}</code>
          </dd>
        </div>
        <div>
          <dt>
            <ShieldCheck size={12} aria-hidden="true" /> Status
          </dt>
          <dd>
            {phase.name === "registered" ? (
              phase.humanId ? (
                <>
                  registered · human <code>{phase.humanId.slice(0, 12)}…</code>
                </>
              ) : (
                hostedChoice === "visitor"
                  ? "registered · this visitor"
                  : "registered · shared demo identity"
              )
            ) : (
              "not registered"
            )}
          </dd>
        </div>
      </dl>

      {phase.name === "idle" && (
        <button type="button" onClick={() => void verify()}>
          {hostedDemo
            ? hostedChoice === "visitor"
              ? "Verify this visitor with World App"
              : "Verify shared identity with World App"
            : "Verify with World App"}
        </button>
      )}
      {phase.name === "connecting" && <p className="world-status">Contacting World Chain…</p>}
      {phase.name === "scan" && (
        <div className="world-scan">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={phase.qrDataUrl} alt="Scan with World App" width={220} height={220} />
          <p>
            Scan with <b>World App</b> and confirm. Waiting for verification…
          </p>
          <a href={phase.connectorURI}>open on this device instead</a>
        </div>
      )}
      {phase.name === "registering" && (
        <p className="world-status">Proof received — relaying registration to World Chain…</p>
      )}
      {phase.name === "registered" && (
        <div className="world-registration-status">
          <p>
            ✓{" "}
            {hostedDemo
              ? hostedChoice === "visitor"
                ? "This visitor identity is"
                : "The shared judge identity is"
              : "Your agents are"}{" "}
            human-backed.
          </p>
          <a
            className="world-explorer-link"
            href={
              phase.txHash
                ? `${WORLDSCAN_URL}/tx/${phase.txHash}`
                : `${WORLDSCAN_URL}/address/${AGENT_BOOK_CONTRACT}#readContract`
            }
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={13} aria-hidden="true" />
            <span>
              <b>
                {phase.txHash
                  ? "View registration transaction"
                  : "Verify in the AgentBook contract"}
              </b>
              <small>Worldscan · Etherscan for World Chain</small>
            </span>
          </a>
          {!phase.txHash && (
            <small className="world-explorer-help">
              In “Read Contract”, call <code>lookupHuman</code> with the
              identity-agent address shown above.
            </small>
          )}
          {hostedDemo && hostedChoice === "visitor" && (
            <button
              type="button"
              className="world-fresh-visitor"
              onClick={() => {
                const sessionId = freshHostedWorldSessionId();
                void loadHostedIdentity(sessionId, "visitor");
              }}
            >
              Create another unverified visitor
            </button>
          )}
        </div>
      )}
      {phase.name === "error" && (
        <p className="world-status world-error">
          {phase.message}{" "}
          <button type="button" onClick={() => setPhase({ name: "idle" })}>
            retry
          </button>
        </p>
      )}
    </section>
  );
}
