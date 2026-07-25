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

- 0G Private Computer E2EE inference with the prompt HPKE-sealed before routing
- Independent browser-side TEE signature plus decrypted request/response hash
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

- The original intent and global budget are encrypted in the browser and
  decrypted by the selected 0G private planner.
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
keeps the primary interaction focused on one Liquid Glass intent box. After a
successful request, an always-visible 0G verification receipt shows the exact
cryptographic proof checked by the browser: 0G chain ID, provider service
contract, on-chain TEE signer, recovered EIP-191 signer, raw signature, signed
proof payload, HPKE metadata, and the independently matched request and response
hashes. Provider, signer, and service contract addresses link to 0G ChainScan.
The Router's
`x_0g_trace` remains visible as explicitly separate, untrusted routing and
billing metadata.

The 0G-generated plan stays attached to that live receipt. Mock buyer
subagents, English-auction transcripts, seller floors, rival valuations, and
simulated receipts are kept in a separate collapsed drawer so they cannot be
mistaken for 0G execution.

Each user enters their own 0G Router key. The key is held only in React memory
for the current browser tab: it is not persisted in local storage, cookies, or
an application database. The browser calls the 0G Router directly, so neither
the key nor the private prompt passes through an application server. Before
that call, the browser:

1. Selects a healthy private `TeeML` provider and pins its on-chain address.
2. Reads that provider's service URL and acknowledged TEE signer from the 0G
   Compute `InferenceServing` contract.
3. Fetches the provider's X25519 key, requires its advertised signer to match
   the on-chain signer, and validates its key ID.
4. HPKE-seals the OpenAI `messages` field with
   `DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / ChaCha20Poly1305`.
5. Sends only the sealed envelope through the Router with provider fallback
   disabled.
6. Authenticates and decrypts the provider-sealed `choices` field locally.

The response must contain a Router request ID, provider address, and a proof
lookup key. The sealed request deliberately omits `verify_tee`: that field is a
Router-only directive which the Router strips before forwarding, so including
it in the authenticated E2EE envelope would make the provider's AAD check fail.
The browser instead performs the stronger verification itself. It uses
`ZG-Res-Key` when the Router exposes it; otherwise it derives the same key from
the documented `chatcmpl-<ZG-Res-Key>` response ID. It then:

1. Re-reads the provider's service record and acknowledged TEE signer from the
   official 0G Compute `InferenceServing` contract on 0G Mainnet.
2. Fetches the signed proof payload and EIP-191 signature from the provider's
   public signature endpoint using the chat ID.
3. Recovers the EIP-191 signer and requires it to equal the on-chain TEE signer.
4. JCS-canonicalizes the locally reconstructed plaintext request and the
   locally decrypted response. Only fields explicitly declared unbound by the
   authenticated E2EE envelope, currently `x_0g_trace`, are excluded.
5. Requires both SHA-256 values to equal the request and response hashes inside
   the signed proof.
6. Exposes the encryption receipt, all four hashes, the raw signature, and the
   complete signed payload.

Only successful E2EE opening, signer recovery, request-hash matching, and
response-hash matching allow the plan to be parsed and the local auctions to
start. A generic top-level claim, mock response, incomplete trace, missing proof
key, wrong signer, invalid signature, changed request, changed plan, or
unacknowledged signer fails closed. `x_0g_trace` is retained as untrusted
routing and billing metadata, but it is not the source of the content
guarantee.

Current limitation: the deployed provider's TDX quote binds its signer address,
but its `report_data` does not yet bind the newly advertised HPKE `enc_pub`.
Consequently, response origin and exact plan content are independently proven
against the on-chain TEE signer, while delivery of the encryption key still
trusts the provider's on-chain HTTPS service endpoint. The receipt exposes
`encryptionKeyAttestationVerified: false` rather than hiding that boundary.

```text
user key + private intent
          |
          v  HPKE seal messages
 browser -> 0G private Router -> pinned TeeML provider
          |
  locally open sealed choices + proof key
                        |
             read 0G service contract
             fetch provider signature
                        |
       match signer + request hash + response hash
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
0G verification receipt only after the independent signer and response-content
checks pass; it does not render the private prompt in the result.

0G currently permits this direct browser call from localhost. A deployed
production origin must be registered with 0G for CORS before the same static
frontend can call the Router. Do not add an application proxy as a workaround:
that would expose both the user's key and private prompt to the application
server.
