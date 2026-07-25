import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

/**
 * Auction Credential Gateway.
 *
 * World AgentKit answers one question: "is this wallet backed by a real,
 * unique human?" — and deliberately answers it with the SAME anonymous
 * humanId for every wallet that human backs. That is an anti-sybil
 * primitive, not an unlinkability primitive: handing the raw humanId to
 * sellers would let them correlate every agent a person runs.
 *
 * The gateway consumes the sensitive fact once and emits only scoped,
 * minimal credentials. A buyer's registered identity agent proves
 * human-backing a single time; each fresh leaf wallet then receives an
 * AuctionPass for one specific auction. The pass carries an
 * auction-scoped nullifier:
 *
 *     nullifier = H(humanId, auctionId)
 *
 * Within one auction the same human always derives the same nullifier, so
 * per-human quotas hold and a scalper's ten wallets collapse into one
 * allocation. Across auctions the nullifiers differ, so colluding sellers
 * cannot join their datasets. The gateway itself is a declared trust point
 * (like the 0G TEE and the clearing account): it briefly learns the
 * humanId ↔ leaf mapping and must not log it. A zero-knowledge credential
 * would remove that trust point; that is roadmap, not weekend.
 */

export type { HumanPolicy } from "../domain";

export interface AuctionPass {
  auctionId: string;
  leafWallet: string;
  /** H(humanId, auctionId) — never the humanId itself. */
  nullifier: string;
  quota: number;
  expiresAt: number;
  /** DER-encoded Ed25519 public key, pinned in the listing's HCS record. */
  issuerPublicKey: string;
  /** Ed25519 signature over every credential field above. */
  signature: string;
}

export interface EnrollmentResult {
  ok: boolean;
  pass?: AuctionPass;
  reason?: string;
}

export interface HumanResolver {
  /** AgentKit shape: agent wallet address → anonymous humanId, or null. */
  lookupHuman(address: string): Promise<string | null>;
}

const PASS_TTL_MS = 15 * 60 * 1000;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function passPayload(pass: Omit<AuctionPass, "signature">): string {
  return [
    pass.auctionId,
    pass.leafWallet,
    pass.nullifier,
    String(pass.quota),
    String(pass.expiresAt),
    pass.issuerPublicKey,
  ].join("|");
}

export function verifyAuctionPass(
  pass: AuctionPass,
  expectedIssuerPublicKey: string,
  auctionId: string,
  leafWallet: string,
  now = Date.now(),
): boolean {
  if (pass.issuerPublicKey !== expectedIssuerPublicKey) return false;
  if (pass.auctionId !== auctionId) return false;
  if (pass.leafWallet !== leafWallet) return false;
  if (pass.expiresAt <= now) return false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(expectedIssuerPublicKey, "base64"),
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      Buffer.from(passPayload(pass)),
      publicKey,
      Buffer.from(pass.signature, "base64"),
    );
  } catch {
    return false;
  }
}

/**
 * Development resolver: simulates the AgentBook. Register identities
 * explicitly; unregistered addresses resolve to null exactly like an
 * unregistered wallet on World Chain. Swapped for
 * `createAgentBookVerifier()` from @worldcoin/agentkit once the identity
 * agent is registered via the AgentKit CLI + World App.
 */
export class MockAgentBook implements HumanResolver {
  private readonly humans = new Map<string, string>();

  registerAgent(address: string, humanSeed: string): void {
    this.humans.set(address.toLowerCase(), hash(`mock-human|${humanSeed}`));
  }

  async lookupHuman(address: string): Promise<string | null> {
    return this.humans.get(address.toLowerCase()) ?? null;
  }
}

/**
 * Route only explicitly named demo identities to the mock book. A negative
 * mock result must stay negative instead of accidentally reaching the real
 * AgentBook, while every other address is resolved canonically.
 */
export function createDemoAwareHumanResolver(
  canonical: HumanResolver,
  demoBook: HumanResolver,
  demoAddresses: ReadonlySet<string>,
): HumanResolver {
  const normalized = new Set(
    [...demoAddresses].map((address) => address.toLowerCase()),
  );
  return {
    lookupHuman: (address) =>
      normalized.has(address.toLowerCase())
        ? demoBook.lookupHuman(address)
        : canonical.lookupHuman(address),
  };
}

export interface GatewayStats {
  passesIssued: number;
  sybilRejections: number;
  notHumanBacked: number;
}

export class WorldGateway {
  private readonly signingKey: KeyObject;
  readonly issuerPublicKey: string;
  /** auctionId → nullifier → passes issued. */
  private readonly issued = new Map<string, Map<string, number>>();
  readonly stats: GatewayStats = {
    passesIssued: 0,
    sybilRejections: 0,
    notHumanBacked: 0,
  };

  constructor(private readonly agentBook: HumanResolver) {
    const keyPair = generateKeyPairSync("ed25519");
    this.signingKey = keyPair.privateKey;
    this.issuerPublicKey = keyPair.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64");
  }

  noteMissingIdentity(): void {
    this.stats.notHumanBacked += 1;
  }

  /**
   * Enroll one fresh leaf wallet into one auction on behalf of a registered
   * identity agent. The identity agent's address is resolved through the
   * AgentBook; the humanId never leaves this method.
   */
  async enroll(input: {
    auctionId: string;
    identityAgent: string;
    leafWallet: string;
    quota?: number;
  }): Promise<EnrollmentResult> {
    const quota = input.quota ?? 1;
    const humanId = await this.agentBook.lookupHuman(input.identityAgent);
    if (!humanId) {
      this.stats.notHumanBacked += 1;
      return {
        ok: false,
        reason:
          "Agent is not backed by a verified human (not in the AgentBook).",
      };
    }

    const nullifier = hash(`${humanId}|${input.auctionId}`);
    const perAuction =
      this.issued.get(input.auctionId) ?? new Map<string, number>();
    this.issued.set(input.auctionId, perAuction);
    const already = perAuction.get(nullifier) ?? 0;
    if (already >= quota) {
      this.stats.sybilRejections += 1;
      return {
        ok: false,
        reason: `This human already holds ${already}/${quota} pass(es) for this auction.`,
      };
    }
    perAuction.set(nullifier, already + 1);

    const unsigned: Omit<AuctionPass, "signature"> = {
      auctionId: input.auctionId,
      leafWallet: input.leafWallet,
      nullifier,
      quota,
      expiresAt: Date.now() + PASS_TTL_MS,
      issuerPublicKey: this.issuerPublicKey,
    };
    const signature = sign(
      null,
      Buffer.from(passPayload(unsigned)),
      this.signingKey,
    ).toString("base64");
    this.stats.passesIssued += 1;
    return { ok: true, pass: { ...unsigned, signature } };
  }

  /** Sellers and the coordinator verify passes without learning anything else. */
  verifyPass(pass: AuctionPass, auctionId: string, leafWallet: string): boolean {
    return verifyAuctionPass(
      pass,
      this.issuerPublicKey,
      auctionId,
      leafWallet,
    );
  }
}

/**
 * Resolve the human resolver for the current environment. The canonical
 * AgentBook is the default; WORLD_AGENTBOOK=mock is an explicit offline-only
 * override. Browser identities still need registration through /world.
 */
export async function createHumanResolver(): Promise<HumanResolver> {
  if (process.env.WORLD_AGENTBOOK === "mock") return new MockAgentBook();
  const { createAgentBookVerifier } = await import("@worldcoin/agentkit");
  const verifier = createAgentBookVerifier();
  return {
    lookupHuman: (address: string) => verifier.lookupHuman(address),
  };
}
