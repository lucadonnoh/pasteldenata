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
keeps the primary interaction focused on one Liquid Glass intent box. Collapsed
drawers expose the full attestation, scoped plan, auction commitments and
reveals, mock seller floors and scores, and simulated receipts for judging.

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
