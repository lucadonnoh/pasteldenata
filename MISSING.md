# World AgentKit integration — what is missing, and what is trusted

Status of the `feat/world-agentkit` workstream: the Auction Credential
Gateway exists, is tested, and demos end to end against a simulated
AgentBook (`npm run demo:scalper`). This document is the honest gap list
and the trust model, written for the team and reusable for the prize
submission.

## What exists

- `src/server/world-gateway.ts` — consumes AgentKit's anti-sybil primitive
  (agent wallet → anonymous humanId; same human → same id) and emits only
  auction-scoped credentials: `nullifier = H(humanId, auctionId)`, wrapped
  in an HMAC-signed `AuctionPass` bound to one leaf wallet and one auction.
- Per-human quotas inside an auction (a scalper's ten wallets collapse into
  one allocation) with unlinkability across auctions (colluding sellers
  cannot join their datasets on a shared identifier).
- `npm run demo:scalper` — 10 sybil wallets across two registered agent
  addresses → 1 pass issued, 9 refused; honest human passes; unregistered
  bot refused; open listing unaffected.
- Four tests pinning the trust model: sybil collapse, cross-auction
  unlinkability, bot rejection, pass tamper-evidence.
- Real-mode switch (`WORLD_AGENTBOOK=real`) that swaps the mock for the
  canonical AgentBook verifier on World Chain via `@worldcoin/agentkit`.

## What is missing

1. **Enforcement in the market pipeline.** Passes can be issued and
   verified, but no auction requires one yet. Planned wiring: listings gain
   a seller-chosen `humanPolicy` (`open` | `one-per-human`), leaf wallets
   are enrolled at spawn time, and the settlement policy refuses to close a
   protected auction for a wallet without a valid pass. The natural
   enforcement point is the seller-side settlement policy introduced in
   PR #14, so this wiring waits for that merge.

2. **Proof of wallet control at enrollment.** The gateway currently trusts
   the caller's claim of its identity-agent address. Real mode must require
   a challenge nonce signed by that address, verified with
   `verifyEVMSignature` from `@worldcoin/agentkit`, before `lookupHuman` is
   consulted. Without this, anyone could enroll using someone else's
   registered address.

3. **Real-mode execution.** Everything currently runs against the simulated
   AgentBook. Going real requires (owner: Davide):
   - a World Dev Portal account,
   - World App on a phone with a verification — Selfie Check works without
     an Orb and is itself a hackathon beta track,
   - registering an identity wallet: `npx @worldcoin/agentkit-cli register
     <address>` (prompts World App),
   - setting `WORLD_AGENTBOOK=real` and running the flow once end to end.
   A mock-only submission reads as a wrapper; at least one real-mode run
   belongs in the demo evidence.

4. **Gateway state persistence.** Quota counters and the HMAC secret are
   in-memory and reset on dev-server reload. Same fix as the settlement
   jobs: pin them on `globalThis` (dev) or a real store (production).

5. **UI surface.** No visible "human-backed" badge on protected listings,
   no sybil-blocked counter in the market view. Needs coordination with the
   UI owner; the demo works from the CLI meanwhile.

6. **Bid-level enforcement (optional hardening).** Current plan enforces at
   enrollment and settlement. A stricter variant also embeds the pass hash
   in every `BID` message so replayers can filter unpassed bids; this
   composes with the payer-verification from PR #14 but is not required for
   the demo.

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
  verify pass signatures and see that two bidders carry different
  nullifiers; they cannot check that the gateway did not issue extra
  passes. (Misbehavior here is detectable in aggregate: more allocations
  than distinct nullifiers.)
- **Buyers** trust it not to log the humanId ↔ wallet mapping. This is a
  privacy trust, not a fund-safety trust: a malicious gateway could
  deanonymize link patterns but could never take money or forge humanity.
- **Nobody** trusts it for payments: budgets remain enforced by wallet
  balances, settlement remains a co-signed atomic swap, and the auction
  history remains independently replayable from HCS.

What World itself provides and what it deliberately does not:

- AgentKit answers "is this wallet backed by a real, unique human?" with
  the same anonymous id for all of one human's wallets. That is an
  anti-sybil primitive, **not** an unlinkability primitive — handing the
  raw humanId to sellers would let them correlate every agent a person
  runs. The gateway exists precisely to convert the sybil-resistant but
  linkable fact into unlinkable, auction-scoped rights.

The honest claim for the demo:

> Leaf agents are unlinkable to sellers and to each other at the
> application layer. The gateway is a declared privacy trust point, exactly
> like the 0G enclave and the clearing account. It cannot mint humanity and
> it cannot touch funds; replacing it with auction-scoped zero-knowledge
> credentials is roadmap, not weekend.

## Known adversarial gaps (state them before judges find them)

- **Uncollateralized bids** (noted in PR #14): a distinct human per wallet
  can still consume one settlement timeout each. The gateway removes the
  *cheap* version of this attack (one human, many wallets); making bids
  costly-to-abandon (collateral) removes the expensive version.
- **Gateway availability**: if the gateway is down, protected auctions
  cannot admit new bidders. Open listings are unaffected by design.
- **Verification freshness**: a pass lives 15 minutes; a stolen leaf key
  within that window could bid in the enrolled auction only. Blast radius
  is one compartment, which is the point of the architecture.
