"use client";

import { ExternalLink, ShieldCheck } from "lucide-react";
import type { DemoResult } from "@/src/domain";
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
              and the key is held only in this tab&apos;s React state.
            </p>
          </div>
          <div>
            <span className="evidence-label enforced">Enforced</span>
            <strong>Private TeeML routing</strong>
            <p>
              Every request sends{" "}
              <code>X-0G-Provider-Trust-Mode: private</code> and{" "}
              <code>verify_tee: true</code>.
            </p>
          </div>
          <div>
            <span className="evidence-label enforced">Verified</span>
            <strong>Synchronous signature check</strong>
            <p>
              The response is accepted only when the documented{" "}
              <code>x_0g_trace.tee_verified</code> field is exactly true.
            </p>
          </div>
        </div>
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

export function ZeroGVerificationReceipt({
  result,
}: {
  result: DemoResult;
}) {
  const costOg = neuronToOg(result.attestation.costNeuron);
  const trace = result.attestation.routerTrace;
  const providerExplorerUrl =
    trace && /^0x[0-9a-fA-F]{40}$/.test(trace.provider)
      ? `${CHAINSCAN_ADDRESS}${trace.provider}`
      : undefined;

  return (
    <section
      className="zerog-receipt"
      aria-label="Live 0G TEE verification receipt"
    >
      <header className="zerog-receipt-header">
        <span className="zerog-seal">
          <ShieldCheck size={15} aria-hidden="true" />
        </span>
        <div>
          <span>LIVE 0G VERIFICATION RECEIPT</span>
          <h2>TEE signature verified by the 0G Router</h2>
          <p>
            The private plan below was accepted only after the Router returned
            its documented verification result inside <code>x_0g_trace</code>.
          </p>
        </div>
        <span className="verification-pill">ROUTER VERIFIED</span>
      </header>

      <div className="zerog-proof-grid">
        <div className="trace-json">
          <div>
            <span>Exact response evidence retained by this browser</span>
            <code>x_0g_trace</code>
          </div>
          <pre>{JSON.stringify(trace, null, 2)}</pre>
        </div>

        <div className="zerog-request-facts">
          <div className="verification-equation">
            <span>Acceptance condition</span>
            <code>x_0g_trace.tee_verified === true</code>
          </div>
          <dl className="evidence-table">
            <div>
              <dt>Routing</dt>
              <dd>
                <code>private</code> · TeeML only
              </dd>
            </div>
            <div>
              <dt>Verification requested</dt>
              <dd>
                <code>verify_tee: true</code>
              </dd>
            </div>
            <div>
              <dt>Endpoint</dt>
              <dd>
                <code>POST {ROUTER_ENDPOINT}</code>
              </dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>
                <code>{result.attestation.model}</code>
              </dd>
            </div>
            <div>
              <dt>Response / chat ID</dt>
              <dd>
                <code>{result.attestation.chatId ?? "Not returned"}</code>
              </dd>
            </div>
            <div>
              <dt>Inference cost</dt>
              <dd>
                {result.attestation.costNeuron ? (
                  <>
                    <code>{result.attestation.costNeuron} neuron</code>
                    {costOg ? ` (${costOg} 0G)` : ""}
                  </>
                ) : (
                  "Not returned"
                )}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      <p className="verification-caveat prominent">
        This is the Router&apos;s synchronous verification receipt: 0G says it
        fetched and validated the provider&apos;s TEE signature before returning
        the response. The Router returns this boolean, not the raw signature.
        ChainScan identifies the provider on 0G, but it is not a receipt for
        this individual inference.
      </p>
      <div className="docs-links">
        {providerExplorerUrl && (
          <DocsLink href={providerExplorerUrl}>
            Provider on 0G ChainScan
          </DocsLink>
        )}
        <DocsLink href={VERIFICATION_DOCS}>
          Verification mechanics
        </DocsLink>
        <DocsLink href={PRIVACY_DOCS}>Privacy-mode guarantee</DocsLink>
      </div>

      <details className="zerog-plan-drawer">
        <summary>
          <span>View the 0G-generated private plan</span>
          <small>
            {result.plan.allocations.length} scoped allocations ·{" "}
            {formatUsd(result.plan.totalBudgetCents)} cap
          </small>
        </summary>
        <div className="zerog-plan-body">
          <div className="trace-heading">
            <div>
              <span>LIVE MODEL OUTPUT</span>
              <h3>Scoped purchasing mandates</h3>
            </div>
            <code>{result.plan.planId}</code>
          </div>
          <div className="plan-summary">
            <span>
              Global cap <b>{formatUsd(result.plan.totalBudgetCents)}</b>
            </span>
            <span>
              Allocated{" "}
              <b>
                {formatUsd(
                  result.plan.totalBudgetCents -
                    result.plan.unallocatedBudgetCents,
                )}
              </b>
            </span>
            <span>
              Contingency{" "}
              <b>{formatUsd(result.plan.unallocatedBudgetCents)}</b>
            </span>
          </div>
          <div className="mandate-list">
            {result.plan.allocations.map((allocation) => (
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
    </section>
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
              <span>MOCKED · SETTLEMENT</span>
              <h3>Independent payment-policy checks</h3>
            </div>
            <span className="mock-pill">NO REAL PAYMENT</span>
          </div>
          <p className="policy-copy">
            The controller rejects category overspend, global overspend,
            cross-plan mandates, category mismatch, and mandate replay before
            creating these simulated receipts.
          </p>
          <div className="receipt-list">
            {result.receipts.map((receipt) => (
              <article key={receipt.id}>
                <span>{receipt.category}</span>
                <strong>{receipt.sellerName}</strong>
                <b>{formatUsd(receipt.amountCents)}</b>
                <code>{receipt.id}</code>
              </article>
            ))}
          </div>
          <div className="settlement-total">
            <span>Simulated total</span>
            <strong>{formatUsd(result.totalSpentCents)}</strong>
            <small>
              under {formatUsd(result.plan.totalBudgetCents)} global cap
            </small>
          </div>
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
