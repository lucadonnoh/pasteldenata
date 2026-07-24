# Pastel de Nata

Private agentic payments for ETHGlobal Lisbon 2026.

A user can say:

> Organize me a date tomorrow in Lisbon. My budget is $200.

The request is planned through 0G Private Computer. The resulting budget is
split into category-scoped spending mandates. Each allocation creates one
independent buyer subagent, which enters seller-run English auctions for
flower, cinema, dinner, transport, or experience inventory. A policy controller
settles the winning bundle only if every category cap and the global cap still
hold.

## What is real

- 0G Router private-tier inference
- TEE verification is required before a plan is accepted
- The model chooses categories, requirements, priorities, and allocations
- Budget, category, replay, and atomic settlement checks are enforced in code
- One scoped buyer subagent is created for every model allocation
- Buyer subagents follow ascending prices and drop at their private valuation

## What is mocked

- Seller auction houses and their heterogeneous inventory
- Seller-set opening floor prices
- Rival buyers and market demand
- USD payment settlement

No real payment is sent.

## Privacy boundaries

- The original intent and global budget go only to the 0G private planner.
- Sellers receive an RFQ containing category, date, location, and requirements.
- Sellers never receive the original prompt, global budget, or category cap.
- A buyer subagent derives a listing-specific private valuation below its
  mandate and never sends the mandate ceiling to the seller.
- Each buyer subagent receives only its category allocation and scoped mandate.
- Receipts contain payment metadata, not the private prompt.

## Mock seller economics

Each seller owns inventory instead of publishing one flat offer. Cinema
inventory, for example, identifies the screen or section, row, and exact pair
of seats. Center seats have higher quality, demand, market estimates, and floor
prices than front-side or rear seats.

Each listing runs a mocked English auction:

1. The auction house opens at the seller's floor price.
2. The allocation-scoped buyer subagent and mock rival buyers respond to each
   visible asking price.
3. The price rises in $0.50 increments and bidders drop when it exceeds their
   private valuation.
4. The last active bidder wins and pays the final asking price.
5. Sold inventory cannot be auctioned again.

This runs in one process for the hackathon. It demonstrates the protocol and
economic shape. Sellers are deterministic mocks, not AI agents, and the rival
buyers and settlement are also simulated.

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
 flowers  cinema  dinner     buyer subagents
     |       |       |
 ascending English auctions  seller floors + mock rivals
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
keeps the primary interaction focused on one Liquid Glass intent box. Collapsed
drawers expose the full attestation, scoped plan, buyer-subagent boundaries,
English-auction transcripts, mock seller floors and rival valuations, and
simulated receipts for judging.

Each user enters their own 0G Router key. The key is held only in React memory
for the current browser tab: it is not persisted in local storage, cookies, or
an application database. The browser calls the 0G Router directly, so neither
the key nor the private prompt passes through an application server.

The response must report a successful private TEE verification before the
browser runs the local mock auctions and payment policy checks. A mock or
unverified response fails closed.

```text
user key + private intent
          |
          v
 browser -> 0G private Router
          |
     verified TEE?
       no /  \ yes
      fail    local mock auctions
                  |
                  v
          local payment checks
```

Run the interface locally:

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`, paste your own 0G key into the password
field, and submit an intent containing a USD budget. The interface displays a
small success summary only after `teeVerified` is exactly `true`; it does not
render the private prompt in the result.

0G currently permits this direct browser call from localhost. A deployed
production origin must be registered with 0G for CORS before the same static
frontend can call the Router. Do not add an application proxy as a workaround:
that would expose both the user's key and private prompt to the application
server.
