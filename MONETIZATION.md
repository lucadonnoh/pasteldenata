# Monetization — the business under the protocol

## Problem

Agent commerce leaks intent. An AI assistant booking your date today
reveals your full budget and plans to every seller and platform it
touches — and the parties who see your reservation price will use it.
Sellers face the mirror problem: bots and scalpers hoarding scarce
inventory faster than humans can click.

## Market size and tailwinds

The problem is measured, growing, and already legislated against:

- **Scalping is industrial.** Automated bots account for roughly a third
  of all internet traffic (Imperva *Bad Bot Report*, 2024), and ticketing
  vendors report bot shares around **40% of ticket-purchase traffic**
  during high-demand onsales (Queue-it industry data). The global
  secondary ticketing market alone is estimated in the **$15B+** range
  (Statista / industry analyses), built almost entirely on inventory
  hoarded faster than humans can buy it.
- **It has spread to restaurants.** Reservation bots resell tables for
  hundreds of dollars (New York Times coverage of Appointment Trader,
  2024), and New York responded with the **Restaurant Reservation
  Anti-Piracy Act (signed December 2024)** — lawmakers are now regulating
  exactly the problem our per-human gating solves at the protocol layer.
- **Incumbent fees set the price umbrella.** Ticketing platforms routinely
  take **20–30%** of face value in fees; reservation platforms charge
  per-cover and SaaS fees. A 1–2.5% take with provable fairness is not a
  discount strategy — it is a different product at a tenth of the price.
- **Privacy is a rising constraint, not a preference.** The FTC opened a
  **surveillance-pricing inquiry (2024)** into companies using personal
  data — budgets, behavior, intent — to set individualized prices: precisely
  the leakage agent commerce multiplies, since an assistant that shops with
  your full context exposes it to every counterparty. Large majorities of
  consumers tell surveys (Cisco Consumer Privacy, Pew) they distrust how
  their data is used in exactly these ways. Regulation and sentiment both
  point toward intent-private purchasing as the default, and TEE-planned,
  scoped-mandate agents are that default implemented.
- **Agentic commerce is arriving with no procurement layer.** Every major
  assistant vendor shipped or announced purchasing agents in the last
  year; analyst projections put agent-mediated commerce in the tens of
  billions within the decade. Those agents currently shop by pretending to
  be browsers. A marketplace built *for* agents — capped wallets,
  auditable auctions, human-gating — is infrastructure the wave is missing.

## Customer segments

- **Buy side**: users of agentic assistants making multi-vendor purchases
  — dates, trips, events. They don't want a marketplace; they want an
  outcome under a budget.
- **Sell side**: sellers of scarce inventory — restaurants, cinemas,
  venues, event operators — who want bot-resistant, human-gated sales and
  provably fair allocation.

## Unique value proposition

The only procurement layer where sellers never see the buyer's full
intent or budget, every auction is publicly replayable, and
payment-for-claim is atomic — no trust required, no chargebacks possible.

## Solution (built, not planned)

TEE-private planning (0G) → scoped buyer agents with ledger-capped
wallets → payer-authenticated HCS auctions → atomic HTS
settlement (NATA-for-claim-NFT, co-signed) → per-listing human gating
(World AgentKit, seller's choice).

## Go-to-market

**Wedge: high-demand restaurant reservations, one city first (Lisbon).**
Why this vertical: scarcity is acute and recurring (the same 20 tables
every Saturday), the scalping pain is documented and now legislated
(NYC's anti-piracy act), integration cost is near zero (a table is a
listing, not a ticketing-stack migration — our seat/table-level inventory
already models it), and human-gating is the exact feature reservation
platforms cannot offer.

- **First sellers to sign**: 5–10 lighthouse restaurants with multi-week
  waitlists — the "Prado" archetype from our catalog. The pitch is one
  sentence: *"your Saturday tables, auctioned to verified humans, one per
  person, with a public transcript proving you didn't play favorites — and
  you keep the clearing price upside scalpers currently capture."*
  Onboarding is the seller studio (`components/seller-studio.tsx`): city,
  inventory, buyer policy, done.
- **Expansion order**: independent cinemas (identical mechanics, higher
  volume) → live events and venues (highest scalper pressure, highest
  take) → additional cities, each opened by its first seller, exactly as
  the product already works (a city exists when its first seller lists).
- **Buy-side channel**: agentic assistant integrations — the planner is an
  API; any assistant can hand a private mandate to the market instead of
  scraping storefronts. Buy-side demand compounds the sell-side pitch:
  sellers list where the agents shop.

## Revenue streams

1. **Take rate on settled auctions** — 1–2.5% of clearing price, paid by
   the seller. Comparable to fees sellers already pay (OpenTable charges
   per-cover fees; ticketing platforms take far more), but bought here
   with something those platforms don't sell: bot-resistance and provable
   fairness.
2. **Premium seller policies as SaaS** — human-gating, per-human quotas,
   priority listing placement, richer auction formats. The World-gated
   `one-per-human` policy is the first paid tier: it demonstrably blocks
   sybils (measured: 10 wallets → 1 allocation) and that is worth money to
   anyone who has fought scalpers.

## Cost structure — the margin story

- **Hedera fees**: the current judge profile uses pre-warmed accounts, 8 fresh
  topics, 30 HCS messages, and 6 atomic swaps in the measured run documented
  in `VALIDATION.md`. Exact mainnet fee modeling remains production work, but
  protocol cost is transaction-based rather than proportional to order value.
- **0G inference**: ~$0.001 per private plan.
- **Coordinator hosting**: single small instance (the Railway judge
  deployment is the template).

## Key metrics

Settled auctions/week · GMV · take-rate revenue · **sybil rejections**
(direct proof the human-gating tier has value) · seller retention ·
plan-to-settlement conversion.

## Unfair advantage

The auditable-settlement protocol itself. Every auction leaves a
payer-authenticated, consensus-timestamped HCS transcript: sellers cannot
run rigged auctions, buyers cannot dispute honest ones, and every settled
claim is an atomic swap that either happened completely or not at all.
Trust stops being a promise and becomes a network effect — each replayable
auction makes the venue more credible than any incumbent whose fairness is
a terms-of-service clause.
