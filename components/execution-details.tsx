"use client";

import { ExternalLink, ShieldCheck } from "lucide-react";
import type { DemoResult } from "@/src/domain";
import { formatUsd, neuronToOg } from "@/src/money";

const PRIVACY_DOCS =
  "https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/privacy";
const VERIFICATION_DOCS =
  "https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/verifiable-execution";
const E2EE_PROTOCOL =
  "https://github.com/0gfoundation/0g-pc-e2ee/blob/main/protocol/SPEC.md";
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
            <strong>Browser-sealed 0G request</strong>
            <p>
              The browser HPKE-encrypts <code>messages</code> to the selected
              provider before calling the Router. There is no application API
              route, and the Router key stays in this tab&apos;s React state.
            </p>
          </div>
          <div>
            <span className="evidence-label enforced">Enforced</span>
            <strong>Pinned private TeeML routing</strong>
            <p>
              The provider is selected from the private TeeML fleet, checked
              on 0G Mainnet, and pinned with Router fallbacks disabled.
            </p>
          </div>
          <div>
            <span className="evidence-label enforced">Local proof</span>
            <strong>Independent browser verification</strong>
            <p>
              This browser decrypts the sealed response, recovers the
              provider&apos;s EIP-191 signer, and matches both signed hashes to
              the exact decrypted request and plan response.
            </p>
          </div>
        </div>
        <p className="mock-boundary-note">
          Current 0G limitation: the provider advertises its HPKE key over its
          on-chain service URL and names the correct on-chain signer, but its
          current TDX quote does not yet bind that encryption key. Response
          origin and plan content are independently verified; encryption-key
          delivery still trusts the provider&apos;s HTTPS endpoint.
        </p>
        <p className="mock-boundary-note">
          After 0G returns the verified plan, seller inventory, auctions, rival
          bids, and USD settlement run as a clearly separated local simulation.
        </p>
        <div className="docs-links">
          <DocsLink href={PRIVACY_DOCS}>0G privacy mode</DocsLink>
          <DocsLink href={VERIFICATION_DOCS}>0G TEE verification</DocsLink>
          <DocsLink href={E2EE_PROTOCOL}>0G E2EE protocol</DocsLink>
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
  const proof = result.attestation.independentVerification;
  if (!proof) return null;

  const providerExplorerUrl =
    trace && /^0x[0-9a-fA-F]{40}$/.test(trace.provider)
      ? `${CHAINSCAN_ADDRESS}${trace.provider}`
      : undefined;
  const signerExplorerUrl = `${CHAINSCAN_ADDRESS}${proof.signingAddress}`;
  const serviceContractExplorerUrl =
    `${CHAINSCAN_ADDRESS}${proof.serviceContract}`;

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
          <span>LIVE · 0G E2EE CONTENT PROOF</span>
          <h2>TEE signer, private request, and exact plan verified</h2>
          <p>
            The browser opened the HPKE response and matched its TEE-signed
            request and response hashes to the local plaintext.
          </p>
        </div>
        <span className="verification-pill">E2EE · CONTENT BOUND</span>
      </header>

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
              signer &amp;&amp; request hash &amp;&amp; response hash
            </code>
          </div>
          <dl className="evidence-table">
            <div>
              <dt>Private-compute protocol</dt>
              <dd>
                <code>{proof.e2ee.protocol}</code>
              </dd>
            </div>
            <div>
              <dt>HPKE suite</dt>
              <dd>
                <code>{proof.e2ee.cipherSuite}</code>
              </dd>
            </div>
            <div>
              <dt>Prompt field</dt>
              <dd>
                <code>{proof.e2ee.requestSealedFields.join(", ")}</code>{" "}
                encrypted before Router
              </dd>
            </div>
            <div>
              <dt>Plan field</dt>
              <dd>
                <code>{proof.e2ee.responseSealedFields.join(", ")}</code>{" "}
                decrypted in this browser
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
                <code>{proof.signedRequestHash}</code>
              </dd>
            </div>
            <div>
              <dt>Computed request hash</dt>
              <dd>
                <code>{proof.computedRequestHash}</code>
              </dd>
            </div>
            <div>
              <dt>Signed response hash</dt>
              <dd>
                <code>{proof.signedResponseHash}</code>
              </dd>
            </div>
            <div>
              <dt>Computed response hash</dt>
              <dd>
                <code>{proof.computedResponseHash}</code>
              </dd>
            </div>
            <div>
              <dt>Content binding</dt>
              <dd>
                <code>{proof.responseHashMethod}</code>
              </dd>
            </div>
            <div>
              <dt>Router-unbound fields</dt>
              <dd>
                {proof.excludedResponseFields.length > 0 ? (
                  <code>{proof.excludedResponseFields.join(", ")}</code>
                ) : (
                  "None"
                )}
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
        No application server performs this check. The browser reconstructs the
        plaintext request, locally opens the authenticated HPKE response,
        JCS-canonicalizes both, and requires both SHA-256 hashes to equal the
        hashes in proof <code>{proof.chatId}</code>. It then performs EIP-191
        recovery and requires the recovered address to equal the acknowledged
        on-chain TEE signer. <code>x_0g_trace</code> is explicitly unbound by
        the E2EE envelope and remains Router corroboration, not part of the
        signed plan.
      </p>
      <p className="verification-caveat">
        Encryption-key trust is narrower than the response proof: key{" "}
        <code>{proof.e2ee.encryptionKeyId}</code> came from the provider&apos;s
        HTTPS endpoint and its advertised signer matches the on-chain signer,
        but the deployed quote does not yet bind <code>enc_pub</code>. The UI
        therefore does not label encryption-key attestation as independently
        verified.
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
        <DocsLink href={proof.e2ee.providerPublicKeyEndpoint}>
          Provider E2EE key
        </DocsLink>
        <DocsLink href={E2EE_PROTOCOL}>E2EE wire specification</DocsLink>
        <DocsLink href={VERIFICATION_DOCS}>
          Verification mechanics
        </DocsLink>
        <DocsLink href={PRIVACY_DOCS}>Privacy-mode guarantee</DocsLink>
      </div>

      <details className="router-corroboration">
        <summary>
          <span>View 0G Router corroboration</span>
          <small>
            unbound routing and billing metadata
          </small>
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
                <code>verify_tee</code> omitted: Router strips that control
                field, so binding it would invalidate the E2EE request. The
                independent content proof above is authoritative.
              </dd>
            </div>
            <div>
              <dt>Router model</dt>
              <dd>
                <code>{result.attestation.model}</code>
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
      </details>

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
