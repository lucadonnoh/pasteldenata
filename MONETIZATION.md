# Monetization — the business under the protocol

## Problem

Agent commerce leaks intent. An AI assistant booking your date today
reveals your full budget and plans to every seller and platform it
touches — and the parties who see your reservation price will use it.
Sellers face the mirror problem: bots and scalpers hoarding scarce
inventory faster than humans can click.

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

## Channels

- **Agentic assistant integrations** — the planner is an API; any
  assistant can hand a mandate to the market instead of scraping
  storefronts.
- **Seller self-onboarding** — already prototyped: the seller studio
  (`components/seller-studio.tsx`) lets a seller pick a city, list
  seat-level inventory, and choose its buyer policy ("1 per human" vs
  open) in one form.

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

- **Hedera fees**: ~$0.0001 average per transaction. One full plan —
  ~150 transactions (13 accounts, 16 topics, 100+ messages, 10 atomic
  swaps; see VALIDATION.md "Network impact") — costs **under two cents**
  to execute. A 2% take on a $176 settled bundle is ~$3.50 against ~$0.02
  of chain cost: **>99% gross margin on settlement rails**.
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
