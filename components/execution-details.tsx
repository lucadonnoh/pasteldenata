"use client";

import { ExternalLink, ShieldCheck } from "lucide-react";
import { MOCK_SELLERS } from "@/src/catalog";
import type { DemoResult } from "@/src/domain";
import { formatUsd, neuronToOg } from "@/src/money";

const PRIVACY_DOCS =
  "https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/privacy";
const VERIFICATION_DOCS =
  "https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/verifiable-execution";
const ROUTER_ENDPOINT = "https://router-api.0g.ai/v1/chat/completions";

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
            <span className="evidence-label mocked">Mocked</span>
            <strong>Sellers and settlement</strong>
            <p>
              Seller inventory, bids, and USD settlement are local simulations.
              The inference and TEE check are not mocked.
            </p>
          </div>
        </div>
        <div className="docs-links">
          <DocsLink href={PRIVACY_DOCS}>0G privacy mode</DocsLink>
          <DocsLink href={VERIFICATION_DOCS}>0G TEE verification</DocsLink>
        </div>
      </div>
    </details>
  );
}

export function ExecutionDetails({ result }: { result: DemoResult }) {
  const costOg = neuronToOg(result.attestation.costNeuron);

  return (
    <details className="transparency-drawer execution-drawer">
      <summary>
        <span>
          <ShieldCheck size={15} aria-hidden="true" />
          Proof and execution details
        </span>
        <small>Attestation · plan · bids · receipts</small>
      </summary>

      <div className="drawer-body execution-body">
        <section className="trace-section">
          <div className="trace-heading">
            <div>
              <span>01 · LIVE INFERENCE</span>
              <h3>0G private TEE evidence</h3>
            </div>
            <span className="verification-pill">TEE VERIFIED</span>
          </div>

          <dl className="evidence-table">
            <div>
              <dt>Router result</dt>
              <dd>
                <code>x_0g_trace.tee_verified = true</code>
              </dd>
            </div>
            <div>
              <dt>Trust mode</dt>
              <dd>
                <code>private</code> · TeeML only
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
              <dt>Provider</dt>
              <dd>
                <code>{result.attestation.provider ?? "Not returned"}</code>
              </dd>
            </div>
            <div>
              <dt>Request ID</dt>
              <dd>
                <code>{result.attestation.requestId ?? "Not returned"}</code>
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

          <p className="verification-caveat">
            This is synchronous verification by the 0G Router. Per 0G&apos;s
            documented trust model, the boolean reports that the Router
            validated the provider&apos;s TEE signature; this demo does not
            independently re-run the signature verification.
          </p>
          <div className="docs-links">
            <DocsLink href={PRIVACY_DOCS}>Privacy-mode guarantee</DocsLink>
            <DocsLink href={VERIFICATION_DOCS}>
              Verification trust model
            </DocsLink>
          </div>
        </section>

        <section className="trace-section">
          <div className="trace-heading">
            <div>
              <span>02 · LIVE MODEL OUTPUT</span>
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
        </section>

        <section className="trace-section">
          <div className="trace-heading">
            <div>
              <span>03 · MOCK SELLER MARKET</span>
              <h3>Commit, reveal, score, select</h3>
            </div>
            <span className="mock-pill">MOCKED SELLERS</span>
          </div>

          <div className="auction-list">
            {result.auctions.map((auction) => (
              <details key={auction.auctionId}>
                <summary>
                  <span>
                    <strong>{auction.category}</strong>
                    {auction.bids.length} sealed bids
                  </span>
                  <span>
                    Winner: {auction.winner.sellerName} ·{" "}
                    {formatUsd(auction.winner.amountCents)}
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
                      <dt>Winning score</dt>
                      <dd>{auction.score.toFixed(2)}</dd>
                    </div>
                  </dl>

                  <div className="bid-list">
                    {auction.bids.map((bid, index) => (
                      <BidInspector
                        key={bid.sellerId}
                        bid={bid}
                        commitment={
                          auction.commitments[index] ?? "Missing commitment"
                        }
                        evaluation={auction.evaluations.find(
                          (evaluation) =>
                            evaluation.sellerId === bid.sellerId,
                        )}
                        winner={bid.sellerId === auction.winner.sellerId}
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
              <span>04 · MOCK SETTLEMENT</span>
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

function BidInspector({
  bid,
  commitment,
  evaluation,
  winner,
}: {
  bid: DemoResult["auctions"][number]["bids"][number];
  commitment: string;
  evaluation:
    | DemoResult["auctions"][number]["evaluations"][number]
    | undefined;
  winner: boolean;
}) {
  const seller = MOCK_SELLERS.find((candidate) => candidate.id === bid.sellerId);

  return (
    <article className={winner ? "winning-bid" : undefined}>
      <header>
        <strong>{bid.sellerName}</strong>
        <b>{formatUsd(bid.amountCents)}</b>
      </header>
      <p>{bid.offering}</p>
      <dl>
        <div>
          <dt>Commitment · checked before selection</dt>
          <dd>
            <code>{commitment}</code>
          </dd>
        </div>
        <div>
          <dt>Reveal salt</dt>
          <dd>
            <code>{bid.salt}</code>
          </dd>
        </div>
        <div>
          <dt>Mock seller floor · inspector only</dt>
          <dd>
            {seller ? formatUsd(seller.reservePriceCents) : "Not available"}
          </dd>
        </div>
        <div>
          <dt>Evaluated score</dt>
          <dd>
            {evaluation
              ? `${evaluation.score.toFixed(2)} · ${
                  evaluation.affordable ? "within mandate" : "over mandate"
                }`
              : "Not available"}
          </dd>
        </div>
        <div>
          <dt>Quality</dt>
          <dd>{bid.quality}/100</dd>
        </div>
        <div>
          <dt>Tags</dt>
          <dd>{bid.tags.join(", ")}</dd>
        </div>
      </dl>
    </article>
  );
}
