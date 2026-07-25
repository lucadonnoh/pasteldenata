"use client";

import { createWorldBridgeStore } from "@worldcoin/idkit-core";
import { solidityEncode } from "@worldcoin/idkit-core/hashing";
import { ExternalLink, KeyRound, ShieldCheck, UserCheck } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { createPublicClient, decodeAbiParameters, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { worldchain } from "viem/chains";

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
  privateKey: `0x${string}`;
  humanId?: string;
  txHash?: `0x${string}`;
}

function loadIdentity(): StoredIdentity | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredIdentity) : null;
  } catch {
    return null;
  }
}

function saveIdentity(identity: StoredIdentity): void {
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
  | { name: "registered"; humanId: string; txHash?: string }
  | { name: "error"; message: string };

/**
 * In-product AgentBook registration: the same flow as the AgentKit CLI —
 * nonce from the AgentBook contract, a World ID bridge session, a QR the
 * human scans with World App, and the signed proof relayed on-chain. The
 * identity key never leaves this browser; the human's World ID never leaves
 * their phone.
 */
export function WorldVerify() {
  const [identity, setIdentity] = useState<StoredIdentity | null>(null);
  const [phase, setPhase] = useState<Phase>({ name: "idle" });

  useEffect(() => {
    // Defer past the initial effect flush; localStorage is browser-only and
    // the lint rule forbids synchronous setState inside effects.
    const timer = window.setTimeout(() => {
      let stored = loadIdentity();
      if (!stored) {
        const privateKey = generatePrivateKey();
        stored = {
          address: privateKeyToAccount(privateKey).address,
          privateKey,
        };
        saveIdentity(stored);
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
    return () => window.clearTimeout(timer);
  }, []);

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
        saveIdentity({ ...identity, humanId });
        const txHash = transactionHash(identity.txHash);
        setPhase({
          name: "registered",
          humanId,
          ...(txHash ? { txHash } : {}),
        });
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
          saveIdentity({
            ...identity,
            humanId,
            ...(txHash ? { txHash } : {}),
          });
          setPhase({
            name: "registered",
            humanId,
            ...(txHash ? { txHash } : {}),
          });
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
        Scarce listings in this market are <b>one allocation per human</b>.
        Registering links your buyer&apos;s identity agent to your anonymous
        World ID in the AgentBook on World Chain — your agents earn bidding
        rights; sellers only ever see auction-scoped nullifiers.
      </p>

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
              <>
                registered · human <code>{phase.humanId.slice(0, 12)}…</code>
              </>
            ) : (
              "not registered"
            )}
          </dd>
        </div>
      </dl>

      {phase.name === "idle" && (
        <button type="button" onClick={() => void verify()}>
          Verify with World App
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
          <p>✓ Your agents are human-backed.</p>
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
