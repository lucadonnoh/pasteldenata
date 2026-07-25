# World AgentKit integration — what is missing, and what is trusted

Status of the `feat/world-agentkit` workstream: the Auction Credential
Gateway exists, is tested, and is **enforced in the market pipeline** —
one-per-human listings cannot settle without a valid auction-scoped pass.
Verified on Hedera testnet in scalper mode: 20 passes issued, 20 sybil
enrollments rejected, 16 pass-less settlement attempts blocked by the
seller policy, while the one distinct human won every category. This
document is the honest gap list and the trust model, written for the team
and reusable for the prize submission.

## What exists

- `src/server/world-gateway.ts` — consumes AgentKit's anti-sybil primitive
  (agent wallet → anonymous humanId; same human → same id) and emits only
  auction-scoped credentials: `nullifier = H(humanId, auctionId)`, wrapped
  in an HMAC-signed `AuctionPass` bound to one leaf wallet and one auction.
  Per-human quotas inside an auction; unlinkability across auctions.
- **Seller-chosen policies**: every seller carries a `humanPolicy` —
  `one-per-human` on the 14 scarce sellers (cinema, dinner, experience in
  both cities), `open` on flowers and transport. The policy is published in
  the on-chain `LISTED` message, so the rules an auction ran under are
  public, consensus-timestamped, and replayable: buyers know them before
  bidding and sellers cannot change them retroactively.
- **Enforcement at settlement**: the market coordinator consults an
  `authorizePurchase` hook in the PREPARE path — the same choke point as
  the auditable-settlement checks from PR #14. Agents are enrolled with the
  gateway the moment their wallets are funded; a protected item cannot be
  claimed without a valid pass, regardless of what was bid.
- **Live sybil demo**: `worldDemo: "scalper"` on the jobs API collapses all
  rival personas into one underlying human; the gateway then admits exactly
  one of their agents per protected item and the coordinator blocks the
  rest at settlement. The job exposes
  `world: { passesIssued, sybilRejections, blocked[] }` for the UI.
  `npm run demo:scalper` remains as the fast offline version.
- Tests pinning the trust model (43 passing on the branch): sybil collapse,
  cross-auction unlinkability, bot rejection, pass tamper-evidence.
- **In-product registration at `/world`**: the AgentKit CLI flow in the
  browser — nonce read from the AgentBook contract, a World ID bridge
  session, a QR scanned with World App, the signed proof relayed on-chain.
  The identity key is generated and kept in the browser; the registered
  address flows into settlement jobs and resolves against the real
  canonical AgentBook on World Chain (`job.world.userSimulated: false`).
  Simulated rival personas stay on the mock book (composite resolver).
- **UI surfacing**: the front page shows the buyer's backing status
  ("Not verified · scarce listings locked" → `/world`; green
  "Human-backed · World ID" once registered) and protected listing cards
  carry a `1/HUMAN` badge; open listings carry nothing because they involve
  no identity check.
- **Real negative path verified**: an unregistered address is refused via a
  live query to the canonical AgentBook on World Chain — the reject side of
  real mode already runs.

## What is missing

1. **Real-mode positive run.** Everything is wired; what remains is one
   human with World App scanning the QR at `/world` (Selfie Check works
   without an Orb and is itself a beta track), then one market run from
   that browser as submission evidence. A mock-only submission reads as a
   wrapper; at least one real-mode run belongs in the video.

2. **Proof of wallet control at enrollment.** The gateway trusts the
   coordinator's claim of which identity agent backs a buyer. Fine while
   the coordinator is the trusted local demo process; real mode should
   require a challenge nonce signed by the identity address, verified with
   `verifyEVMSignature` from `@worldcoin/agentkit`, before `lookupHuman` is
   consulted.

3. **UI surface.** The data is on the job API (per-listing `humanPolicy`,
   pass/rejection/block counters), but nothing renders it yet: a
   "human-backed · one per human" badge on protected listings, a "sybils
   blocked" counter during the scalper demo, and an explainer line in the
   proof drawer. Needs coordination with the UI owner.

4. **Bid-level enforcement (optional hardening).** Precisely: unverified
   buyers cannot SETTLE protected items, but pass-less bids can still land
   on the topic, push prices, and burn a forfeiture timeout each (PR #14's
   known boundary). The fix is twofold: coordinators mark protected
   listings ineligible in an unbacked agent's mandate (it never bids), and
   replayers filter bids that carry no pass hash. Documented, not built —
   the demo answer is "allocation rights are gated; bid spam is an
   acknowledged griefing vector with a known fix."

5. **Gateway quota persistence across jobs.** Quotas live for the duration
   of one settlement job, which matches auctions living inside one job. If
   auctions ever span jobs (e.g. standing listings), quota state must move
   to a store keyed by nullifier, not process memory.

## What is trusted, and by whom

The system has three declared trust points. Each sees one compartment;
nobody sees the whole picture.

| Trust point | What it learns | What it cannot do | Path to removal |
|---|---|---|---|
| 0G TEE planner | The full intent and budget | Spend money; its plan is clamped by deterministic policy | Attested enclaves already; signer verified in-browser |
| Clearing account | Funding flows between buyer wallets and agents | Overspend a mandate; balances are ledger-capped | Escrow contracts or per-buyer channels |
| **Credential gateway** | humanId ↔ leaf-wallet links, briefly, at enrollment | Fake humanity (passes require a real AgentBook entry); spend anything | Auction-scoped zero-knowledge credentials |

What each party must trust about the gateway:

- **Sellers** trust it to enforce the per-human quota honestly. They can
  verify pass signatures and see distinct nullifiers per bidder; they
  cannot check that the gateway never over-issued. Misbehavior is
  detectable in aggregate (more allocations than distinct nullifiers), and
  the policy each auction ran under is pinned in its `LISTED` message.
- **Buyers** trust it not to log the humanId ↔ wallet mapping. This is a
  privacy trust, not a fund-safety trust: a malicious gateway could
  deanonymize link patterns but can never take money or forge humanity.
- **Nobody** trusts it for payments: budgets remain enforced by wallet
  balances, settlement remains a co-signed atomic swap validated on both
  sides, and the auction history remains independently replayable from
  HCS.

What World provides and what it deliberately does not:

- AgentKit answers "is this wallet backed by a real, unique human?" with
  the same anonymous id for all of one human's wallets. That is an
  anti-sybil primitive, **not** an unlinkability primitive — handing the
  raw humanId to sellers would let them correlate every agent a person
  runs. The gateway exists precisely to convert the sybil-resistant but
  linkable fact into unlinkable, auction-scoped rights.

The honest claim for the demo:

> Human verification appears exactly where scarcity makes sellers
> adversarial targets, chosen per listing by the seller and pinned
> on-chain — not marketplace-wide identity ceremony. Leaf agents stay
> unlinkable to sellers and to each other; the gateway is a declared
> privacy trust point that can neither mint humanity nor touch funds.
> Replacing it with auction-scoped zero-knowledge credentials is roadmap,
> not weekend.

## Known adversarial gaps (state them before judges find them)

- **Pass-less bidding**: agents without passes can bid (bids are
  uncollateralized) and waste a settlement timeout each, per the boundary
  already documented in PR #14. The gateway removes the cheap version of
  the attack (one human, many *winning* wallets); bid-level pass filtering
  and/or collateral remove the expensive version.
- **Gateway availability**: if the gateway is down, protected auctions
  cannot admit new bidders. Open listings are unaffected by design.
- **Verification freshness**: a pass lives 15 minutes and is bound to one
  wallet and one auction; a stolen leaf key within that window can bid in
  the enrolled auction only. Blast radius is one compartment, which is the
  point of the architecture.
