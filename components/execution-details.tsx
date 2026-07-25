"use client";

import { ExternalLink, ShieldCheck } from "lucide-react";
import type {
  DemoResult,
  PlannerAttestation,
  PrivatePlan,
} from "@/src/domain";
import { formatUsd, neuronToOg } from "@/src/money";

const PRIVACY_DOCS =
  "https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/privacy";
const VERIFICATION_DOCS =
  "https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/verifiable-execution";
const ROUTER_ENDPOINT = "https://router-api.0g.ai/v1/chat/completions";
const CHAINSCAN_ADDRESS = "https://chainscan.0g.ai/address/";

function DocsLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
      <ExternalLink size={11} aria-hidden="true" />
    </a>
  );
}

export function PrivacyDetails() {
  return (
    <details className="transparency-drawer privacy-drawer">
      <summary>
        <span>How the private call works</span>
        <small>Inspect the trust boundary</small>
      </summary>
      <div className="drawer-body">
        <div className="evidence-grid">
          <div>
            <span className="evidence-label live">Live</span>
            <strong>Browser → 0G Router</strong>
            <p>
              This page calls 0G directly. There is no application API route,
              and the user&apos;s key stays in this tab&apos;s React state.
            </p>
          </div>
          <div>
            <span className="evidence-label enforced">Enforced</span>
            <strong>Private TeeML sealed inference</strong>
            <p>
              Every request sends{" "}
              <code>X-0G-Provider-Trust-Mode: private</code>. 0G documents that
              this routes only to TeeML, where the model and prompt stay inside
              the enclave.
            </p>
          </div>
          <div>
            <span className="evidence-label enforced">Two checks</span>
            <strong>Router + independent signer verification</strong>
            <p>
              The Router must return <code>tee_verified: true</code>. The
              browser also recovers the provider&apos;s EIP-191 signer and
              matches it to the acknowledged signer recorded on 0G.
            </p>
          </div>
        </div>
        <p className="mock-boundary-note">
          0G calls this private or sealed inference. It is not the separate
          draft <code>_e2ee</code> HPKE payload protocol: production uses a
          normal OpenAI-compatible <code>messages</code> request plus the
          private routing header.
        </p>
        <p className="mock-boundary-note">
          After 0G returns the verified plan, seller inventory, auctions, rival
          bids, and USD settlement run as a clearly separated local simulation.
        </p>
        <div className="docs-links">
          <DocsLink href={PRIVACY_DOCS}>0G privacy mode</DocsLink>
          <DocsLink href={VERIFICATION_DOCS}>0G TEE verification</DocsLink>
        </div>
      </div>
    </details>
  );
}

type ZeroGVerificationReceiptProps =
  | { result: DemoResult; attestation?: never; plan?: never }
  | {
      result?: never;
      attestation: PlannerAttestation;
      plan?: PrivatePlan;
    };

export function ZeroGVerificationReceipt(
  props: ZeroGVerificationReceiptProps,
) {
  const attestation =
    "result" in props && props.result
      ? props.result.attestation
      : props.attestation;
  const plan =
    "result" in props && props.result ? props.result.plan : props.plan;
  const costOg = neuronToOg(attestation.costNeuron);
  const trace = attestation.routerTrace;
  const proof = attestation.independentVerification;
  if (!proof) return null;

  const providerExplorerUrl =
    trace && /^0x[0-9a-fA-F]{40}$/.test(trace.provider)
      ? `${CHAINSCAN_ADDRESS}${trace.provider}`
      : undefined;
  const signerExplorerUrl = `${CHAINSCAN_ADDRESS}${proof.signingAddress}`;
  const serviceContractExplorerUrl =
    `${CHAINSCAN_ADDRESS}${proof.serviceContract}`;

  return (
    <details
      className="zerog-receipt"
      aria-label="Live 0G TEE verification receipt"
    >
      <summary className="zerog-receipt-header">
        <span className="zerog-seal">
          <ShieldCheck size={15} aria-hidden="true" />
        </span>
        <div>
          <span>LIVE · 0G PRIVATE TEE RECEIPT</span>
          <h2>Private routing and TEE signer verified</h2>
          <p>
            0G verified the response synchronously, then this browser
            independently checked the signed proof against the on-chain signer.
          </p>
        </div>
        <span className="verification-pill">VERIFIED · TEEML</span>
        <i className="zerog-receipt-caret" aria-hidden="true" />
      </summary>

      <div className="zerog-proof-grid">
        <div className="trace-json">
          <div>
            <span>Cryptographic verification receipt</span>
            <code>EIP-191</code>
          </div>
          <pre>{JSON.stringify(proof, null, 2)}</pre>
        </div>

        <div className="zerog-request-facts">
          <div className="verification-equation">
            <span>Acceptance condition</span>
            <code>
              tee_verified &amp;&amp; signer === on-chain signer
            </code>
          </div>
          <dl className="evidence-table">
            <div>
              <dt>Routing</dt>
              <dd>
                <code>private</code> · TeeML only
              </dd>
            </div>
            <div>
              <dt>Router verification</dt>
              <dd>
                <code>verify_tee: true</code> ·{" "}
                <code>tee_verified: true</code>
              </dd>
            </div>
            <div>
              <dt>On-chain lookup</dt>
              <dd>
                0G Mainnet · chain <code>{proof.chainId}</code>
              </dd>
            </div>
            <div>
              <dt>Provider service</dt>
              <dd>
                <code>{proof.verifiability}</code> ·{" "}
                <code>{proof.serviceModel}</code>
              </dd>
            </div>
            <div>
              <dt>Expected signer</dt>
              <dd>
                <code>{proof.signingAddress}</code>
              </dd>
            </div>
            <div>
              <dt>Recovered signer</dt>
              <dd>
                <code>{proof.recoveredAddress}</code>
              </dd>
            </div>
            <div>
              <dt>Signed request hash</dt>
              <dd>
                <code>{proof.signedRequestHash ?? "Not exposed"}</code>
              </dd>
            </div>
            <div>
              <dt>Signed response hash</dt>
              <dd>
                <code>{proof.signedResponseHash ?? "Not exposed"}</code>
              </dd>
            </div>
            <div>
              <dt>Message hash</dt>
              <dd>
                <code>{proof.messageHash}</code>
              </dd>
            </div>
          </dl>
        </div>
      </div>

      <p className="verification-caveat prominent">
        The independent check proves that proof <code>{proof.chatId}</code> was
        signed by the acknowledged TeeML signer. The exact plan-to-response-hash
        match is still trusted to the Router&apos;s synchronous{" "}
        <code>tee_verified</code> check because the Router adds metadata to the
        provider response before this browser receives it.
      </p>
      <div className="docs-links">
        {providerExplorerUrl && (
          <DocsLink href={providerExplorerUrl}>
            Provider on 0G ChainScan
          </DocsLink>
        )}
        <DocsLink href={signerExplorerUrl}>TEE signer on ChainScan</DocsLink>
        <DocsLink href={serviceContractExplorerUrl}>
          0G service contract
        </DocsLink>
        <DocsLink href={VERIFICATION_DOCS}>
          Verification mechanics
        </DocsLink>
        <DocsLink href={PRIVACY_DOCS}>Privacy-mode guarantee</DocsLink>
      </div>

      <details className="router-corroboration">
        <summary>
          <span>View 0G Router corroboration</span>
          <small>routing, verification, and billing metadata</small>
        </summary>
        <div>
          <pre>{JSON.stringify(trace, null, 2)}</pre>
          <dl className="evidence-table">
            <div>
              <dt>Request</dt>
              <dd>
                <code>POST {ROUTER_ENDPOINT}</code>
              </dd>
            </div>
            <div>
              <dt>Routing</dt>
              <dd>
                <code>private</code> · TeeML only
              </dd>
            </div>
            <div>
              <dt>Router verification</dt>
              <dd>
                <code>verify_tee: true</code> requested and{" "}
                <code>x_0g_trace.tee_verified: true</code> required
              </dd>
            </div>
            <div>
              <dt>Router model</dt>
              <dd>
                <code>{attestation.model}</code>
              </dd>
            </div>
            <div>
              <dt>Inference cost</dt>
              <dd>
                {attestation.costNeuron ? (
                  <>
                    <code>{attestation.costNeuron} neuron</code>
                    {costOg ? ` (${costOg} 0G)` : ""}
                  </>
                ) : (
                  "Not returned"
                )}
              </dd>
            </div>
          </dl>
        </div>
      </details>

      {plan && (
        <details className="zerog-plan-drawer">
          <summary>
            <span>View the 0G-generated private plan</span>
            <small>
              {plan.allocations.length} scoped allocations ·{" "}
              {formatUsd(plan.totalBudgetCents)} cap
            </small>
          </summary>
          <div className="zerog-plan-body">
            <div className="trace-heading">
              <div>
                <span>VERIFIED PROPOSAL · LOCAL POLICY ENFORCED</span>
                <h3>Scoped purchasing mandates</h3>
              </div>
              <code>{plan.planId}</code>
            </div>
            {attestation.localPolicyAdjustments &&
              attestation.localPolicyAdjustments.length > 0 && (
              <div className="verification-caveat prominent">
                <p>
                  0G proposed allocations outside the hard local policy. The
                  browser deterministically repaired the cents below after
                  inference; these changes are not claimed as TEE model output.
                </p>
                <pre>
                  {attestation.localPolicyAdjustments.join("\n")}
                </pre>
              </div>
              )}
            <div className="plan-summary">
              <span>
                Global cap <b>{formatUsd(plan.totalBudgetCents)}</b>
              </span>
              <span>
                Allocated{" "}
                <b>
                  {formatUsd(
                    plan.totalBudgetCents -
                      plan.unallocatedBudgetCents,
                  )}
                </b>
              </span>
              <span>
                Contingency{" "}
                <b>{formatUsd(plan.unallocatedBudgetCents)}</b>
              </span>
            </div>
            <div className="mandate-list">
              {plan.allocations.map((allocation) => (
                <article key={allocation.category}>
                  <header>
                    <strong>{allocation.category}</strong>
                    <span>{formatUsd(allocation.maxBudgetCents)} cap</span>
                  </header>
                  <p>{allocation.requirements.join(" · ")}</p>
                  <small>Priority {allocation.priority}/5</small>
                </article>
              ))}
            </div>
          </div>
        </details>
      )}
    </details>
  );
}

export function MockExecutionDetails({ result }: { result: DemoResult }) {
  return (
    <details className="transparency-drawer mock-execution-drawer">
      <summary>
        <span>Inspect mocked market simulation</span>
        <small>Buyer subagents · English auctions · fake receipts</small>
      </summary>

      <div className="drawer-body execution-body">
        <section className="trace-section">
          <div className="trace-heading">
            <div>
              <span>MOCKED · ALLOCATION BUYER SUBAGENTS</span>
              <h3>Scoped agents in ascending English auctions</h3>
            </div>
            <span className="mock-pill">MOCKED MARKET</span>
          </div>
          <p className="policy-copy">
            Every allocation creates one buyer subagent. Sellers are
            deterministic mock auction houses—not AI agents—and mocked rivals
            provide competitive demand.
          </p>

          <div className="auction-list">
            {result.auctions.map((auction) => (
              <details key={auction.auctionId}>
                <summary>
                  <span>
                    <strong>{auction.category}</strong>
                    {auction.listingAuctions.length} listing auction
                    {auction.listingAuctions.length === 1 ? "" : "s"}
                  </span>
                  <span>
                    Winner: {auction.winner.sellerName} ·{" "}
                    {formatUsd(auction.winner.amountCents)}
                  </span>
                </summary>
                <div className="auction-detail">
                  <dl className="evidence-table compact">
                    <div>
                      <dt>Buyer subagent</dt>
                      <dd>
                        <code>{auction.buyerSubagent.id}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Mandate ID</dt>
                      <dd>
                        <code>{auction.mandate.id}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Maximum spend</dt>
                      <dd>{formatUsd(auction.mandate.maxAmountCents)}</dd>
                    </div>
                    <div>
                      <dt>Private strategy</dt>
                      <dd>{auction.buyerSubagent.strategy}</dd>
                    </div>
                    <div>
                      <dt>Requirements</dt>
                      <dd>
                        {auction.buyerSubagent.requirements.join(" · ")}
                      </dd>
                    </div>
                  </dl>

                  <div className="listing-auction-list">
                    {auction.listingAuctions.map((listingAuction) => (
                      <EnglishAuctionInspector
                        key={listingAuction.auctionId}
                        auction={listingAuction}
                      />
                    ))}
                  </div>
                </div>
              </details>
            ))}
          </div>
        </section>

        <section className="trace-section">
          <div className="trace-heading">
            <div>
              <span>
                {result.hedera ? "04 · HEDERA SETTLEMENT" : "04 · MOCK SETTLEMENT"}
              </span>
              <h3>Independent payment-policy checks</h3>
            </div>
            {result.hedera ? (
              <span className="verification-pill">REAL TESTNET PAYMENT</span>
            ) : (
              <span className="mock-pill">NO REAL PAYMENT</span>
            )}
          </div>
          <p className="policy-copy">
            The controller rejects category overspend, global overspend,
            cross-plan mandates, category mismatch, and mandate replay before
            settlement.
            {result.hedera &&
              " For each live market purchase, the coordinator replayed payer-bound HCS bids and the authenticated close. Every ranked buyer had a fixed claim window; an expired winner could be promoted only through an authenticated HCS FORFEITED event. The seller rechecked the current winner and exact NATA-for-claim bytes before signing, then the coordinator submitted the fully authorized atomic swap."}
          </p>
          <div className="receipt-list">
            {result.receipts.map((receipt) => (
              <article key={receipt.id}>
                <span>{receipt.category}</span>
                <strong>{receipt.sellerName}</strong>
                <b>{formatUsd(receipt.amountCents)}</b>
                {receipt.hashscanUrl ? (
                  <a
                    href={receipt.hashscanUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    agent {receipt.escrowAccountId} · claim NFT #
                    {receipt.claimNftSerial} · HashScan
                    <ExternalLink size={11} aria-hidden="true" />
                  </a>
                ) : (
                  <code>{receipt.id}</code>
                )}
              </article>
            ))}
          </div>
          <div className="settlement-total">
            <span>{result.hedera ? "Settled total" : "Simulated total"}</span>
            <strong>{formatUsd(result.totalSpentCents)}</strong>
            <small>
              under {formatUsd(result.plan.totalBudgetCents)} global cap
            </small>
          </div>
          {result.hedera && (
            <div className="docs-links">
              <DocsLink
                href={`https://hashscan.io/testnet/token/${result.hedera.paymentTokenId}`}
              >
                NATA token
              </DocsLink>
              <DocsLink
                href={`https://hashscan.io/testnet/account/${result.hedera.buyerAccountId}`}
              >
                Buyer wallet
              </DocsLink>
              <DocsLink
                href={`https://hashscan.io/testnet/token/${result.hedera.claimTokenId}`}
              >
                Claim NFTs
              </DocsLink>
            </div>
          )}
        </section>
      </div>
    </details>
  );
}

function EnglishAuctionInspector({
  auction,
}: {
  auction: DemoResult["auctions"][number]["listingAuctions"][number];
}) {
  return (
    <details className="listing-auction">
      <summary>
        <span>
          <strong>{auction.listing.sellerName}</strong>
          {auction.listing.offering}
        </span>
        <span>
          {auction.status} · {auction.steps.length} ascending steps
          {auction.clearingPriceCents === null
            ? ""
            : ` · ${formatUsd(auction.clearingPriceCents)}`}
        </span>
      </summary>

      <div className="auction-detail">
        <dl className="evidence-table compact">
          <div>
            <dt>Auction ID</dt>
            <dd>
              <code>{auction.auctionId}</code>
            </dd>
          </div>
          <div>
            <dt>Listing score</dt>
            <dd>{auction.listingScore.toFixed(2)}</dd>
          </div>
          <div>
            <dt>Seller floor</dt>
            <dd>
              {formatUsd(auction.debugSellerFloorPriceCents)}
            </dd>
          </div>
          <div>
            <dt>Increment</dt>
            <dd>{formatUsd(auction.minimumIncrementCents)}</dd>
          </div>
          <div>
            <dt>Buyer private max</dt>
            <dd>{formatUsd(auction.buyerMaxBidCents)}</dd>
          </div>
          <div>
            <dt>Winner</dt>
            <dd>
              <code>{auction.winningBidderId ?? "No bidder"}</code>
            </dd>
          </div>
        </dl>

        <h4 className="inspector-heading">
          Participants · debug valuations
        </h4>
        <div className="bid-list">
          {auction.participants.map((participant) => (
            <article
              key={participant.bidderId}
              className={
                participant.bidderId === auction.winningBidderId
                  ? "winning-bid"
                  : undefined
              }
            >
              <header>
                <strong>{participant.bidderId}</strong>
                <b>{formatUsd(participant.debugMaxBidCents)}</b>
              </header>
              <p>{participant.bidderKind}</p>
            </article>
          ))}
        </div>

        <h4 className="inspector-heading">Ascending transcript</h4>
        {auction.steps.length === 0 ? (
          <p className="policy-copy">No bidder met the opening floor.</p>
        ) : (
          <ol className="auction-transcript">
            {auction.steps.map((step) => (
              <li key={step.sequence}>
                <b>#{step.sequence}</b>
                <strong>{formatUsd(step.askingPriceCents)}</strong>
                <span>
                  Lead: {step.leadingBidderId ?? "none"}
                  <small>
                    Active: {step.activeBidderIds.join(", ") || "none"}
                    {step.droppedBidderIds.length > 0
                      ? ` · Dropped: ${step.droppedBidderIds.join(", ")}`
                      : ""}
                  </small>
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}
