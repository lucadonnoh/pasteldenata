import { createHmac, createHash, randomBytes } from "node:crypto";

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
  /** HMAC over the fields above with the gateway secret. */
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
  ].join("|");
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

export interface GatewayStats {
  passesIssued: number;
  sybilRejections: number;
  notHumanBacked: number;
}

export class WorldGateway {
  private readonly secret: string;
  /** auctionId → nullifier → passes issued. */
  private readonly issued = new Map<string, Map<string, number>>();
  readonly stats: GatewayStats = {
    passesIssued: 0,
    sybilRejections: 0,
    notHumanBacked: 0,
  };

  constructor(
    private readonly agentBook: HumanResolver,
    secret = randomBytes(32).toString("hex"),
  ) {
    this.secret = secret;
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
    };
    const signature = createHmac("sha256", this.secret)
      .update(passPayload(unsigned))
      .digest("hex");
    this.stats.passesIssued += 1;
    return { ok: true, pass: { ...unsigned, signature } };
  }

  /** Sellers and the coordinator verify passes without learning anything else. */
  verifyPass(pass: AuctionPass, auctionId: string, leafWallet: string): boolean {
    if (pass.auctionId !== auctionId) return false;
    if (pass.leafWallet !== leafWallet) return false;
    if (pass.expiresAt < Date.now()) return false;
    const expected = createHmac("sha256", this.secret)
      .update(passPayload(pass))
      .digest("hex");
    return expected === pass.signature;
  }
}

/**
 * Resolve the human resolver for the current environment. Real mode uses
 * the canonical AgentBook on World Chain via @worldcoin/agentkit; it
 * activates when WORLD_AGENTBOOK=real is set and the identity agent has
 * been registered with `npx @worldcoin/agentkit-cli register <address>`.
 */
export async function createHumanResolver(): Promise<HumanResolver> {
  if (process.env.WORLD_AGENTBOOK === "real") {
    const { createAgentBookVerifier } = await import("@worldcoin/agentkit");
    const verifier = createAgentBookVerifier();
    return {
      lookupHuman: (address: string) => verifier.lookupHuman(address),
    };
  }
  return new MockAgentBook();
}
