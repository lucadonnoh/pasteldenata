# Pastel de Nata

Private agentic payments for ETHGlobal Lisbon 2026.

A user can say:

> Organize me a date tomorrow in Lisbon. My budget is $200.

The request is planned through 0G Private Computer. The resulting budget is
split into category-scoped spending mandates. Independent buyer agents then run
mock sealed-bid reverse auctions against flower, cinema, dinner, transport, and
experience sellers. A policy controller settles the winning bundle only if
every category cap and the global cap still hold.

## What is real

- 0G Router private-tier inference
- TEE verification is required before a plan is accepted
- The model chooses categories, requirements, priorities, and allocations
- Budget, category, replay, and atomic settlement checks are enforced in code
- Seller bids use commit/reveal semantics

## What is mocked

- Seller inventory and prices
- Seller bid generation
- USD payment settlement

No real payment is sent.

## Privacy boundaries

- The original intent and global budget go only to the 0G private planner.
- Sellers receive an RFQ containing category, date, location, and requirements.
- Sellers never receive the original prompt, global budget, category cap, or
  competing bids.
- Each buyer agent can spend only its scoped mandate.
- Receipts contain payment metadata, not the private prompt.

The commit/reveal auction is simulated in one process for the hackathon. It
demonstrates the protocol shape but is not yet a cryptographically private
multi-party auction.

## Run

Requires Node.js 22 or newer.

```bash
npm install
cp .env.example .env
# Put the Router key in .env as ZEROG_KEY

npm run demo -- \
  "Organize me a date tomorrow in Lisbon. My budget is $200."
```

Run the full flow without calling 0G:

```bash
npm run demo:mock
```

Validate the policy invariants:

```bash
npm run check
```

## Flow

```text
private intent + hard cap
          |
          v
  0G private planner
          |
          v
 scoped spend mandates
     /      |      \
 flowers  cinema  dinner     buyer agents
     |       |       |
 sealed mock auctions        sellers see no budget
     \       |      /
          winners
             |
             v
  independent policy checks
             |
             v
  simulated atomic settlement
```

## Web interface

The repository also includes a minimal Next.js interface for the live demo. It
is intentionally focused on the first interaction: one Liquid Glass intent box,
private processing feedback, and no implementation-detail dashboard.

The browser sends the intent to `POST /api/intent`. The route calls the same
`organizePrivatePurchase` orchestrator used by the CLI, so the web demo and the
tested protocol flow cannot drift apart.

```text
Liquid Glass intent box
          |
          v
   POST /api/intent
          |
          v
 organizePrivatePurchase
     /           \
 0G planner    mock planner
     \           /
    auctions + policy checks
```

Run the interface locally:

```bash
npm install
cp .env.example .env
npm run dev
```

Then open `http://localhost:3000`.

For UI development without a Router key:

```env
DEMO_MODE=true
```

For the private 0G flow:

```env
ZEROG_KEY=sk-your-router-key
DEMO_MODE=false
```

The current UI does not render the generated plan, winners, or mock receipts.
The API already runs that flow, but those views are deliberately deferred until
the interaction design is ready.
