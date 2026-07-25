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
- USD payment settlement, unless run with `--hedera`

By default no real payment is sent. With `--hedera`, settlement runs on the
Hedera testnet with real HTS transfers.

## Hedera agent swarm (`--hedera`)

Built with the Hedera SDK only — no Solidity. One isolated buyer agent per
mandate, each a separate OS process holding only its own wallet key and one
scoped mandate:

- **Fresh leaf wallets.** Each agent gets a new Hedera account funded with
  exactly its category cap in NATA (an HTS token, 1 unit = 1 USD cent) plus a
  little HBAR to pay its own fees. The agent never sees the intent, the
  global budget, or its siblings — and the ledger physically caps its
  spending at its balance.
- **Unlinkable at the application layer.** Leaves are funded by the
  marketplace clearing account, not the buyer wallet, each auction has its
  own HCS topic, and claim NFTs stay in the leaf wallets. Sellers see three
  unrelated bidders. The clearing account is a declared trust point (like the
  0G TEE); this is compartmentalization, not cryptographic anonymity.
- **Two-party atomic settlement.** The leaf builds and signs one
  `TransferTransaction` (its NATA out, the claim NFT in), the seller agent
  counter-signs it, and the leaf submits it as fee payer. All legs succeed or
  none do. Unspent remainders flow back to the buyer through clearing.
- **Replayable auction log.** Each auction topic records the RFQ and the
  settlement on HCS, auditable on HashScan / Mirror Node. No private data
  (intent, global budget, category caps) is ever published.

## Live auctions (`--hedera-live`)

The full version: instead of a one-shot RFQ, each auction runs as a live
reverse auction **on its HCS topic**. Sellers enter at list price and
publicly undercut and concede — each bid a `TopicMessageSubmitTransaction`
signed and paid by that seller's own account, never below its private
reserve. The buying agent watches the topic through Mirror Node, closes the
auction when bidding goes quiet, and picks the best offer against its
private preferences. If every standing offer exceeds its cap, the agent asks
the root for contingency budget, which arrives as a real on-chain transfer
before the cap is raised — cross-agent budget reallocation, enforced by the
ledger. Price discovery is real (winners routinely get pushed to their
reserve) and the entire bid history is replayable on HashScan.

```bash
npm run demo:live         # 0G private planner + live HCS auctions
npm run demo:live:mock    # mock planner + live HCS auctions
```

`--hedera` keeps the sealed one-shot variant; `--hedera-simple` keeps the
single-process escrow fallback. In every mode the policy checks run in code
first, and the token balances enforce the hard budget even against a
malicious planner output.

## Multi-buyer open market (`--market`)

Five buyers, five private mandates, one public market. Each persona's intent
goes to its own private planner call; nobody — including the other buyers —
sees anyone else's budget or priorities. Every seller lists one scarce item
at its price, which is the **auction floor**: competition between strangers'
agents is the only thing that pushes prices up. Agents bid ascending on
their best-scored affordable listing, raise when outbid, ask their own root
for contingency when priced out (granted as a real on-chain transfer
mid-war), retarget when their item sells to someone else, and walk away when
outbid beyond their mandate. First settlement wins the item; one table can
never sell twice.

A single run produces genuine market behavior: bid wars 20–30 messages deep
on popular items, prices settling 20%+ above floor, and scarcity allocated
by willingness to pay — all replayable per item on HashScan.

```bash
npm run demo:market         # five 0G-planned buyers compete
npm run demo:market:mock    # five mock-planned buyers compete
```

## What is missing

- **Independent seller agents.** Sellers bid from their own Hedera accounts,
  but their pricing logic runs inside the root process, which also
  counter-signs settlements. Real seller agents would run as their own
  processes (or machines) and hold their own keys.
- **Smarter leaf agents.** Leaves score bids deterministically. Each leaf
  could make one scoped 0G call to judge qualitative fit (requirements vs.
  offering) without ever seeing the global mandate.
- **Human-gated auctions.** Seller-selectable one-allocation-per-human
  policies (World AgentKit style) are not started.
- **A UI.** Everything is CLI. The budget flowing from the buyer through
  clearing into the leaf wallets and back — and the live bid war on each
  topic — is the demo's best visual.
- **Reclaiming leaf HBAR.** Each run leaves a few HBAR of fee float in the
  leaf wallets; fine on testnet, sloppy in production.

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

Settle for real on the Hedera testnet (add `HEDERA_OPERATOR_ID` and
`HEDERA_OPERATOR_KEY` to `.env` from a free
[portal.hedera.com](https://portal.hedera.com) account):

```bash
npm run hedera:setup        # one-time: creates NATA token, claim NFTs, wallets
npm run demo:hedera         # 0G planner + agent swarm settlement
npm run demo:hedera:mock    # mock planner + agent swarm settlement
npm run demo:hedera:simple  # mock planner + single-process escrow fallback
```

Generated testnet accounts are stored in `hedera-infra.json` (gitignored).

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
   atomic settlement
   simulated by default
   real HTS escrow + NFT swap with --hedera
   auction history on HCS
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
