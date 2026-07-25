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

## What is implemented

- 0G Router privacy mode, restricted to private TeeML sealed inference
- Router-side TEE verification plus independent browser-side EIP-191 signer
  verification are required before a plan is accepted
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

- The original intent and global budget go only to a private TeeML provider,
  where 0G documents that the model and prompt remain inside the enclave.
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

The default flow runs in one process for the hackathon. It demonstrates the
protocol and economic shape with deterministic mock sellers and rival buyers.
The Hedera modes below replace the simulated payment/market trace with real
testnet accounts, authenticated HCS messages, and atomic HTS settlement.

## Hedera testnet settlement

The CLI can replace simulated payment with HTS transfers on Hedera testnet:

```bash
npm run hedera:setup
npm run demo:hedera:mock
```

`demo:hedera:mock` uses the recorded English-auction winners. `demo:live:mock`
runs authenticated reverse-auction messages on HCS, while `demo:market:mock`
starts several private buyer plans in a shared ascending market. These modes
use testnet assets only.

Each mandate runs in a separate trusted child process with a fresh Hedera
wallet funded to its scoped cap. The process boundary compartmentalizes buyer
data; it is not a sandbox for untrusted agent code. Every HCS auction topic has
a fresh submit key, and readers accept a bid only when its Mirror Node payer
matches the registered seller or bidder identity.

Leaf keys are written before funding to
`.pasteldenata/hedera-wallets/<account>.json`. Both the directory and files are
owner-only (`0700` and `0600`) and ignored by git. The records contain plaintext
testnet keys and must not be copied into the web application or committed.

Settlement does not fail fast. The root waits for every leaf to exit, compares
confirmed receipts with actual token balances, sweeps every recoverable
remainder, refunds buyers, and then reports any partial failure together with
transactions that already became irreversible.

The web settlement endpoint is a local demo coordinator, not a public backend.
It accepts same-origin requests on loopback only, validates the complete plan
and auction shape, and runs at most one ledger job at a time. The browser sends
the derived plan and mock auction trace to this trusted local process; the
original prompt and 0G key remain in browser memory. Do not expose the
coordinator remotely without adding deployment-grade authentication.

### City-scoped mock markets

Seller inventory follows the location returned in the independently verified
0G plan. The repository currently includes 12 Lisbon sellers and 9 Milan
sellers, including San Siro match tickets, Brera and Navigli restaurants,
local transport, cinema seats, and flowers. Recorded auctions, live reverse
auctions, and the shared ascending market all use the same city roster.
Unknown locations currently fall back to Lisbon.

The market does not make a second server-side 0G request: each user keeps
control of their own Router key, and that key never enters the local Hedera
coordinator. Adding arbitrary-city catalog generation should therefore happen
in the browser under the same user-owned credential and verification policy.

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
keeps the primary interaction focused on one Liquid Glass intent box. After a
successful request, it navigates to an in-memory market route. The recorded
local mock-market execution is presented first, with the live 0G verification
receipt immediately below it. The receipt includes the private trust mode,
Router TEE result, 0G chain ID, provider service contract, on-chain TEE signer,
recovered EIP-191 signer, raw signature, and signed proof payload. Provider,
signer, and service contract addresses link to 0G ChainScan. The Router's exact
`x_0g_trace` remains visible alongside the independent proof.

The accepted plan stays attached to that live receipt. If 0G slightly
overshoots the hard budget or underfunds a mocked market floor, deterministic
browser policy repairs the scoped cents before any auction; every adjustment
is listed in the receipt and is explicitly not represented as TEE model output.
An explicit trust-boundary banner separates the plan from a visible playback
of the recorded mock English-auction trace. That playback uses the executed
buyer IDs, listing attempts, asking prices, leaders, and dropouts; it does not
synthesize fake bids or wallet addresses. The complete mock transcript, seller
floors, debug valuations, and simulated receipts remain available in a
separate collapsed drawer.

Each user enters their own 0G Router key. The key is held only in React memory
for the current browser tab: it is not persisted in local storage, cookies, or
an application database. The browser calls the 0G Router directly, so neither
the key nor the private prompt passes through an application server.

The production request follows 0G's documented privacy-mode API:

1. `POST /v1/chat/completions` with a normal OpenAI-compatible `messages` body.
2. `X-0G-Provider-Trust-Mode: private` restricts routing to TeeML providers. If
   none is available, 0G fails the request rather than falling back.
3. `verify_tee: true` asks the Router to verify the provider's signature.
4. The response is accepted only when
   `x_0g_trace.tee_verified === true` and the trace names a request and provider.

0G describes this as private or sealed inference: the model itself runs in the
TEE, prompts do not leave the enclave, and the host sees encrypted traffic. It
is distinct from the separate draft `_e2ee` HPKE payload protocol; this app does
not send that unsupported envelope to the public Router.

The browser also performs the documented independent signer check. It uses
`ZG-Res-Key` when exposed, otherwise derives the provider proof key from the
`chatcmpl-<ZG-Res-Key>` response ID. It then:

1. Re-reads the provider's service record and acknowledged TEE signer from the
   official 0G Compute `InferenceServing` contract on 0G Mainnet.
2. Fetches the signed proof payload and EIP-191 signature from the provider's
   public signature endpoint using the chat ID.
3. Recovers the EIP-191 signer and requires it to equal the on-chain TEE signer.
4. Exposes the complete signed payload, raw signature, expected signer, and
   recovered signer.

Only successful Router verification and independent signer recovery allow the
plan to be parsed and the local auctions to start. A generic top-level claim,
mock response, incomplete trace, missing proof key, wrong signer, invalid
signature, or unacknowledged signer fails closed.

Trust boundary: the independent EIP-191 check proves that the proof came from
the acknowledged TeeML signer. The exact response-hash-to-plan comparison still
relies on the Router's synchronous `tee_verified` result because the Router adds
its own trace and billing fields before the browser receives the response.
The UI states this rather than presenting Router verification as a fully
independent content proof.

```text
user key + private intent
          |
          v
 browser -> 0G Router -- private only --> TeeML provider
          |
  require x_0g_trace.tee_verified === true
                        |
             read 0G service contract
             fetch provider signature
                        |
        independently match EIP-191 signer
                   no /       \ yes
                  fail     parse verified plan
                               |
                        local mock auctions
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
field, and submit an intent containing a USD budget. The interface renders the
0G verification receipt only after Router verification and the independent
signer check pass; it does not render the private prompt in the result.

0G currently permits this direct browser call from localhost. A deployed
production origin must be registered with 0G for CORS before the same static
frontend can call the Router. Do not add an application proxy as a workaround:
that would expose both the user's key and private prompt to the application
server.
