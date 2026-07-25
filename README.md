# Pastel de Nata

Private agentic procurement for ETHGlobal Lisbon 2026.

A user can ask:

> Organize me a date tomorrow in Lisbon. My budget is $200.

Pastel de Nata turns that private intent into a bundle of scoped purchasing
mandates. Independent buyer agents compete for flowers, cinema seats, dinner
reservations, transport, or experiences without disclosing the user's entire
intent or total budget to every seller. Winning purchases can settle on Hedera
testnet as one atomic exchange of a payment token for a claim NFT.

The product combines three ideas:

1. **Private planning:** 0G private TeeML inference converts the user's intent
   into a structured procurement plan.
2. **Scoped buyer agents:** every allocation becomes a separate agent with its
   own requirements, spending cap, and funded wallet.
3. **Auditable markets and settlement:** HCS records the auction transcript,
   while HTS atomically exchanges payment for the reservation or ticket claim.
4. **Human-gated scarcity:** sellers can require one allocation per verified
   human using World AgentKit without revealing a reusable human identifier to
   bidders or other sellers.

This is a hackathon prototype. The privacy, market, and settlement layers have
different trust boundaries, which are documented below.

## Product offering

The intended product is a private buyer-side concierge:

1. The user supplies a natural-language intent and hard budget.
2. A confidential planner chooses a practical bundle, such as flowers,
   cinema, and dinner.
3. Local policy converts the plan into category-scoped mandates whose sum
   cannot exceed the user's hard budget.
4. One buyer agent per mandate searches the available seller inventory and
   bids only within its own cap.
5. Each winning seller confirms by signing an atomic payment-for-claim
   transaction.
6. The user receives payment receipts, HCS auction proofs, and claim NFTs that
   represent the booked products or services.

The claim NFT is analogous to a restaurant reservation confirmation or event
ticket. In the current prototype it proves the on-chain exchange, not the
physical delivery of dinner, flowers, or another off-chain service.

## What runs today

The web product has one fail-closed path:

| Layer | Web product |
| --- | --- |
| Planning | Real 0G private TeeML call with independent proof verification |
| Seller catalog | Mocked multi-city inventory and floor prices |
| Rival demand | Demo rival personas using real testnet accounts |
| World identity | Real browser registration plus an explicit mix of mock human-backed and unverified rivals |
| Auction | Real HCS messages and payer-bound Mirror Node replay |
| Payment | Real HTS transfer of test token `NATA` |
| Product claim | Real testnet `NATAC` NFT delivered atomically with payment |
| Fulfillment | Not implemented |

The homepage requires either an explicitly verified browser-owned 0G key or a
configured hosted demo key, plus a conservative live Hedera balance estimate,
before it enables the intent. Every returned plan must still pass Router and
independent TEE checks before it reaches the Hedera market. If the live job
fails, the interface reports failure or confirmed partial receipts; it never
substitutes an in-process auction or simulated purchase.

No real merchant is paid. `NATA` has no economic value and all Hedera activity
uses testnet. A real 0G inference request still consumes Router credit:
user-owned credit in local BYOK mode or the shared project credit in hosted
demo mode.

The sellers, their inventory, floor prices, and rival buyer strategies are
mocked. The Hedera accounts, HCS consensus messages, HTS transfers, transaction
signatures, and claim NFTs are real testnet operations.

## Architecture

```text
USER'S BROWSER
  private intent + hard budget
          |                         \
          | hosted demo              \ local BYOK
          v                           v
 RAILWAY COORDINATOR           0G ROUTER directly
 (shared 0G key; sees prompt)          |
          |                            |
          +-------------> 0G ROUTER <-+
             private-provider routing
                         |
                         v
                TeeML model provider
                         |
               verified plan + proof
                         v
                 local policy
                         |
                         v
             HEDERA COORDINATOR
              /          |          \
       flowers agent  cinema agent  dinner agent
          scoped wallet + mandate + category cap
                         |
          World AgentBook + credential gateway
       (protected listings; auction-scoped nullifier)
              \          |          /
                  HCS AUCTIONS
                         |
              exact buyer/seller signatures
                         v
          ATOMIC HTS PAYMENT <-> CLAIM NFT
```

### 1. Browser, hosted demo, and 0G planner

Local BYOK mode holds the user's 0G key in React memory for the current tab and
calls the 0G Router directly. Hosted demo mode removes the key field: Railway
holds the shared `ZEROG_KEY` as a server-only secret and forwards the plaintext
intent to the same private TeeML route. The hosted mode avoids browser CORS and
key setup for judges, but Railway is consequently inside the prompt
confidentiality boundary. The key is never included in client JavaScript.

The planner receives more than the free-form text. The request contains:

- the original private intent;
- the hard budget in integer US cents;
- the target date;
- the currency and default location;
- the public catalog of available categories, sellers, inventory, quality,
  tags, attributes, and market estimates;
- instructions to return a JSON object containing categories, requirements,
  priorities, and scoped allocations.

The browser rejects malformed plans, duplicate categories, impossible dates,
and budget violations. Small allocation inconsistencies can be repaired
deterministically; every repair is displayed separately and is not presented
as TEE model output.

### 2. Scoped buyer agents

Every accepted allocation becomes one child process with:

- one category;
- only that category's requirements;
- a category spending cap;
- a fresh Hedera testnet wallet funded to that cap;
- access to public listings for that category.

The child does not receive the original prompt, the global budget, sibling
mandates, or sibling wallet keys. The coordinator creates the child and its
wallet, so this is compartmentalization within a trusted local system—not
protection from a malicious coordinator and not a sandbox for untrusted code.

### 3. Seller-facing data

A seller-side auction receives only:

- auction and listing identifiers;
- category;
- location and scheduled date;
- category-specific requirements.

It does not receive the original intent, global budget, category cap, or the
agent's private valuation. In the shared Hedera market, public HCS messages
additionally expose seller listings, floor prices, bidder account IDs, bid
amounts, close and forfeiture events, and final transaction IDs.

### 4. Local coordinator

The Next.js settlement endpoint is intentionally a localhost-only demo
coordinator. It:

- validates the complete plan-to-auction relationship;
- owns the Hedera testnet operator credential and mocked seller credentials;
- creates and funds buyer-agent wallets;
- starts at most one settlement job at a time;
- streams actual HCS and Mirror Node state to the browser;
- reconciles final token balances, sweeps recoverable remainders, and reports
  partial failures without hiding transactions that already finalized.

The job store is in memory and survives development hot reloads, but not a full
process restart. This endpoint is not a production payment API.

### 5. World identity and scarce allocations

The browser creates a dedicated EVM identity key and keeps it in local storage.
At `/world`, the user scans a World App QR to register that address in the
canonical AgentBook on World Chain. Before a settlement job may use the
address, the localhost coordinator issues a one-time, five-minute challenge
bound to the plan ID. The browser signs it with the identity key; the
coordinator verifies and consumes it before consulting the AgentBook. A public
registered address alone is therefore insufficient.

For `one-per-human` listings, the credential gateway converts the private
AgentBook `humanId` into `H(humanId, auctionId)`. It issues a 15-minute
Ed25519-signed pass bound to one auction and one leaf wallet. The issuer public
key and seller policy are pinned in `LISTED`; a successful pass is independently
rechecked by seller policy and written to HCS as `AUTHORIZED` before the seller
signs.

The demo does not pretend every rival has a real World ID. Rival identities are
explicit server-side fixtures: some resolve to distinct mock humans and some
are deliberately unverified and are blocked from protected settlement. They
never substitute for the real user's browser identity. Scalper mode assigns
the verified mock rivals one shared human so their wallets collapse to one
allocation per protected auction.

## Auction protocol

### HCS shared market

Mock sellers own heterogeneous inventory rather than publishing one flat
offer. A cinema listing identifies a screen, row, and exact pair of seats;
central seats generally have higher floors. The Hedera market gives each
scarce listing a fresh HCS topic:

1. `LISTED` records the inventory and seller floor.
2. `BID` records a bidder account and amount. A bid is valid only when Mirror
   Node identifies the same Hedera payer account named in the message.
3. `CLOSED` freezes the auction after the configured minimum duration and
   quiet period, or at the hard deadline. Later bids are ignored.
4. The fixed ranking keeps the highest bid from each distinct account, orders
   higher amounts first, and breaks equal bids by earlier HCS consensus
   sequence.
5. For a protected listing, `AUTHORIZED` records the winner's
   gateway-signed, auction-scoped nullifier. Seller policy verifies the
   signature, auction, wallet, expiry, quota, and issuer key.
6. Each ranked buyer receives a 30-second claim window.
7. If the current winner never provides its buyer signature, the coordinator
   records an authenticated `FORFEITED` event after the deadline. The next
   distinct account in the fixed ranking becomes eligible.
8. `SETTLED` records the successful Hedera transaction ID.

Seller policy independently replays the payer-bound listing, bids, close,
deadlines, and forfeitures before it signs. A premature forfeiture, incorrect
winner, incorrect amount, or post-close bid causes settlement to fail.

An honest lower-ranked agent stays online after it can no longer afford another
raise. Its last valid bid remains eligible if higher bidders time out.

## Atomic Hedera settlement

The testnet infrastructure creates:

- `NATA`, a fungible HTS demo token with two decimals;
- `NATAC`, an HTS NFT collection for reservation and ticket claims;
- mocked seller accounts;
- buyer funding accounts and fresh scoped bidding-agent accounts.

The winning buyer constructs and signs one frozen `TransferTransaction`. Before
adding the seller signature, seller policy requires all of the following:

- the transaction fee payer is the winning buyer;
- the exact winning amount of `NATA` moves buyer to seller;
- the exact prepared `NATAC` serial moves seller to buyer;
- the buyer, seller, token IDs, and NFT serial match the replayed auction;
- there are no additional fungible-token, NFT, or HBAR transfers.

The seller's signature is the reservation confirmation. If the seller refuses
to sign, the reservation is unavailable: the transaction cannot execute, the
buyer pays nothing, and no claim NFT moves to the buyer. This is an acceptable
availability outcome, like a restaurant declining a reservation request.

Once both signatures exist, the trusted coordinator submits the fully
authorized transaction. The buyer cannot withhold submission after authorizing
the purchase. Hedera applies the payment and NFT transfer atomically, so the
seller cannot receive `NATA` while withholding that on-chain claim.

Atomicity does not enforce the off-chain service. The buyer trusts the seller
to honor the claim NFT when the user arrives at the restaurant, cinema, or
other venue.

## Privacy model

### What is protected from whom

| Data | Visible to |
| --- | --- |
| 0G key | Browser tab and 0G Router request endpoint |
| Original intent and hard budget | Browser, 0G Router request path, selected TeeML inference environment |
| Public seller catalog | Browser and 0G planner |
| Derived global plan | Browser and trusted local coordinator |
| World identity private key | Browser local storage |
| AgentBook human ID | Canonical AgentBook and trusted credential gateway |
| Auction-scoped World nullifier and pass signature | Public HCS topic for that listing |
| Scoped category mandate | Coordinator and that buyer child process |
| Seller request | Relevant seller-side auction logic |
| HCS listing, bids, accounts, amounts, outcomes | Public Hedera observers |
| Hedera wallet private keys | Trusted local coordinator/child and local recovery files |
| Off-chain fulfillment details | Not implemented |

The application server does not receive the original prompt or 0G key. After
planning, the browser sends only the verified derived plan to the localhost
coordinator. The coordinator creates the buyer mandates and all auction state
inside the live Hedera job. The derived plan is therefore not private from
that trusted local process.

HCS is a public audit log, not a privacy system. Anyone can inspect bid amounts,
Hedera accounts, auction timing, claim NFTs, and transaction IDs. The original
prompt and global budget are not written to HCS, but public activity can still
reveal purchasing categories and create linkability.

### 0G private inference

The request uses the OpenAI-compatible 0G Router endpoint with:

- `X-0G-Provider-Trust-Mode: private`;
- `verify_tee: true`;
- fail-closed validation requiring
  `x_0g_trace.tee_verified === true`;
- a complete Router trace containing the request and provider identity.

Private trust mode prevents silent fallback to a non-private provider. The app
accepts a plan only after Router verification and a separate signer check both
succeed.

The browser independently:

1. reads the provider's service record from the 0G Compute
   `InferenceServing` contract on 0G Mainnet;
2. requires `TeeML` verifiability and an acknowledged TEE signer;
3. fetches the provider's signed proof payload using the chat ID;
4. recovers the EIP-191 signer;
5. requires it to match the acknowledged on-chain TEE signer.

This independent check establishes that the proof was signed by the registered
TEE signer. It does **not** independently prove that the exact plan bytes
received from the Router match the provider's signed response hash. The Router
adds or transforms response fields before the browser receives the response,
so exact content binding currently relies on the Router's synchronous
`tee_verified` result.

### What “private” does not mean here

The browser posts a normal JSON request over HTTPS to the 0G Router. This
repository does not implement the separate HPKE `_e2ee` envelope or another
browser-to-enclave encrypted payload. It therefore does not claim cryptographic
end-to-end encryption from the browser directly to the model enclave. The 0G
Router remains inside the request-confidentiality trust boundary.

TEE verification proves provider identity and execution provenance under the
0G and hardware trust assumptions. It does not prove that the model chose a
good plan, that the public catalog is truthful, or that an off-chain seller
will fulfill a claim.

### Key handling

For the web flow, each user enters their own 0G key. The key stays in React
memory for the current tab and is not written to local storage, cookies, the
Hedera coordinator, or an application database. A compromised frontend,
browser extension, or same-origin script could still read it.

For the CLI, `ZEROG_KEY` is read from the local `.env`.

The browser's generated World identity private key persists in local storage so
the same registered AgentBook address can authorize later plans. It never goes
to the coordinator; only plan-bound EIP-191 signatures do. A compromised
frontend, browser extension, or same-origin script could steal this key, so
production custody would require stronger browser key storage.

Generated Hedera testnet credentials are stored in `hedera-infra.json` and
`.pasteldenata/hedera-wallets/`. They are ignored by git and written with
owner-only permissions, but they are plaintext testnet keys and are not
production-grade custody.

## Trust model

| Actor or component | Trusted for | Enforced or auditable boundary |
| --- | --- | --- |
| User's browser | Holding the key in local BYOK mode and enforcing the frontend flow | A BYOK key is memory-only; hosted secrets never enter client JavaScript |
| 0G Router | Handling request plaintext confidentially, private routing, and exact response verification | Private mode, `verify_tee`, complete trace, and fail-closed checks |
| TeeML provider and TEE stack | Confidential model execution and signed proof production | Provider service record and EIP-191 signer are independently checked |
| Coordinator | Hosted-mode prompt forwarding, availability, orchestration, wallet funding, mocked seller signing, and correct progression | Plan validation, public HCS history, exact transaction checks, and ledger reconciliation make deviations observable |
| User's own buyer agents | Choosing listings and authorizing spend within their mandates | Each wallet contains its scoped cap plus only explicitly granted contingency; parent policy revalidates results |
| Other buyers | Not trusted | Bids are payer-bound, ranking is deterministic, and non-settling winners time out |
| World AgentBook | Correct human-backed address lookup | The user must also prove control of that public address |
| Credential gateway | Private human-ID lookup, quota issuance, and unlinkable nullifiers | Ed25519 passes, issuer key, policy, and successful `AUTHORIZED` records are public; duplicate nullifiers are detectable |
| Seller | May refuse availability; not trusted to receive payment without transferring the claim | Both signatures are required and payment-for-NFT settlement is atomic |
| Seller for off-chain service | Trusted to honor a valid claim NFT | Not enforced by this prototype |
| Hedera consensus and Mirror Node | Consensus ordering, final settlement, and readable HCS state | HashScan links and full topics are public; Mirror availability is still required by the app |

The coordinator is trusted but auditable, not trustless. It can censor, delay,
or stop the market. Incorrect close, ranking, forfeiture, or settlement
messages are detectable from HCS, but the protocol does not force an offline
coordinator to make progress.

The credential gateway is part of that trusted coordinator boundary. Public
HCS evidence proves which issuer key authorized which bidder and makes
duplicate auction nullifiers detectable; it cannot prove that the gateway
honestly performed its private AgentBook lookup. A malicious gateway could
invent credentials, but it still cannot sign for the buyer, move funds, or
bypass the atomic payment-for-claim transaction.

The current mocked seller private keys are held by the coordinator. The code
demonstrates the seller verification policy and atomic transaction shape, not
an adversarial remote seller deployment. In a production marketplace each
seller would run or control its own signing service.

## Limitations and open work

### Marketplace and fulfillment

- Sellers, inventory, floor prices, and rival personas are mocked.
- Lisbon and Milan have explicit catalogs; unknown locations currently fall
  back to Lisbon.
- A `NATAC` claim is not a legal reservation, ticket, refund right, or delivery
  guarantee.
- Seller refusal is safe but unavailable: no signature means no payment and no
  claim. The current prototype reports the failure rather than guaranteeing an
  automatic alternative booking.
- Seller fulfillment, cancellations, refunds, disputes, identity, reputation,
  and claim redemption are not implemented.

### Auction liveness and market integrity

- Bid amounts are not collateralized or locked when submitted.
- A non-settling bidder is delayed by one 30-second claim window and then
  forfeited.
- This restores liveness across a finite fixed ranking, but it is not Sybil
  resistance for bidding. One attacker can use multiple funded accounts and
  consume one timeout per account because World authorization is checked at
  settlement, not when the bid is submitted.
- Protected settlement prevents those accounts from receiving multiple scarce
  allocations. Preventing bid-level griefing still requires pass-bound bids,
  bid bonds, collateral and slashing, or contract-enforced bids.
- A trusted coordinator or required network service going offline can pause
  progress.

### Privacy and verification

- Local BYOK excludes the application server from the original prompt path.
  Hosted demo mode intentionally sends the plaintext prompt through Railway.
- Neither mode implements browser-to-enclave cryptographic E2EE.
- Request confidentiality still trusts the 0G Router and its private inference
  path.
- Independent EIP-191 verification proves the registered signer, while exact
  response-to-plan content binding still trusts Router `tee_verified`.
- The derived plan is intentionally disclosed to the coordinator.
- HCS auction metadata is public and linkable.
- Process isolation limits accidental data sharing but is not a security
  sandbox, and the coordinator creates the child keys.

### Deployment and operations

- Local settlement defaults to loopback-only. Hosted demo mode explicitly
  allows remote same-origin requests and adds per-caller and global hourly
  budgets, but the unadvertised Railway URL is not production authentication.
- Settlement jobs and progress state are in memory.
- Hedera keys and generated child keys are plaintext testnet secrets. Railway
  deployments persist generated infrastructure and wallet recovery files on
  an attached volume.
- The app relies on 0G Router, the provider signature endpoint, 0G RPC, Hedera
  consensus, and Hedera Mirror Node availability.
- Local BYOK from a new deployed origin depends on 0G CORS. Hosted mode uses a
  same-origin application route instead, so no browser-to-0G CORS grant is
  required; the tradeoff is that Railway sees the prompt.
- The 30-second claim window and other auction timings are prototype constants,
  not production service-level parameters.

## Run locally

Requires Node.js 22 or newer.

```bash
npm install
cp .env.example .env
```

### Web flow

```bash
npm run dev
```

Open `http://localhost:3000` and enter your own 0G Router key in the interface.
The web flow keeps that key in the browser; it does not read `ZEROG_KEY` from
the server environment.

Open `http://localhost:3000/world` to register the browser identity with World
App. This is optional: an unverified user can use open listings but is refused
by `one-per-human` sellers.

For Hedera settlement from the web interface, also configure:

```dotenv
HEDERA_OPERATOR_ID=0.0.your-testnet-account
HEDERA_OPERATOR_KEY=your-testnet-private-key
```

Then initialize the reusable testnet infrastructure for the market you will
demo (Lisbon is the default):

```bash
npm run hedera:setup
# or, for another market:
npm run hedera:setup -- Tokyo
```

Only that city's mock sellers are provisioned. Accounts are checkpointed
one at a time, and another city is added lazily when first used. The operator
needs enough faucet HBAR to create and fund the selected sellers, buyer, and
scoped agent accounts.

### Railway judge demo

The hosted judge mode uses one Next.js service, one replica, and an attached
volume mounted at `/data`. Configure these server-only variables:

```dotenv
HOSTED_DEMO_MODE=true
ZEROG_SERVER_DEMO=true
ZEROG_KEY=sk-your-project-key
HEDERA_ALLOW_REMOTE=true
HEDERA_OPERATOR_ID=0.0.your-testnet-account
HEDERA_OPERATOR_KEY=your-testnet-private-key
DEMO_MAX_RUNS_PER_IP_PER_HOUR=10
DEMO_MAX_RUNS_PER_HOUR=30
```

Railway supplies `PORT` and `RAILWAY_VOLUME_MOUNT_PATH`; neither should be
hardcoded. `railway.json` pins one replica because settlement jobs are
in-memory and configures `/api/health` without performing billable or external
checks. The browser calls only same-origin application routes in hosted mode,
and those routes reject cross-origin browser requests.

### Hedera market CLI

```bash
# Five private 0G plans compete in shared HCS English auctions
npm run demo

# Same real Hedera market with deterministic plans for the demo buyers
npm run demo:market:mock
```

Both commands require the Hedera testnet environment. The mock variant replaces
only 0G planning for the fixed demo buyers; it does not replace the HCS
auctions, agent wallets, ranking, timeouts, or atomic HTS settlement. There is
no in-process auction or simulated-payment mode.

### Validate

```bash
npm run check
npm run build
```

## What the demo exposes

The interface keeps proof and execution detail available without putting it in
the primary interaction:

- the accepted 0G plan and any local policy adjustments;
- the exact Router `x_0g_trace`;
- provider service-contract and signer addresses;
- the signed provider proof, raw signature, expected signer, and recovered
  signer;
- real Hedera agent accounts and HCS bid streams;
- HashScan links for auction topics, atomic transactions, accounts, and claim
  NFTs.

These details let judges distinguish real 0G and Hedera operations from the
mocked marketplace actors.

## Repository map

```text
src/planner.ts                 0G request, plan parsing, local budget policy
src/zerog-private.ts           private Router request and fail-closed handling
src/tee-verifier.ts            on-chain service and EIP-191 signer verification
src/hedera/market.ts           shared HCS market and coordinator settlement
src/hedera/marketPolicy.ts     close, ranking, timeout, and exact-swap policy
src/hedera/mirror.ts           payer-bound HCS replay
src/hedera/leafAgent.ts        isolated scoped buyer agent
src/server/world-identity-auth.ts
                               one-time browser identity challenge verification
src/server/world-gateway.ts    AgentBook lookup and signed auction credentials
src/server/settlement-jobs.ts  settlement job coordinator
components/execution-details.tsx
                               visible 0G and Hedera proof details
```
