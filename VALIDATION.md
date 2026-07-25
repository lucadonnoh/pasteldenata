# Validation — credentials, environments, and how judges can verify

This project depends on three external credential systems: a 0G Router key
(private TEE inference), a Hedera testnet operator (funding and
settlement), and a World ID (human-backed agents). During the hackathon we
exercised **multiple independent keys and accounts on each system**, and
every properly funded credential worked interchangeably — the app is bound
to protocols, not to any specific account.

## What we validated

### 0G Router

- Multiple router keys were created and tested across both environments:
  the **mainnet router** (`router-api.0g.ai`, model `0gm-1.0-35b-a3b`,
  private TeeML routing) and the **testnet router**
  (`pc.testnet.0g.ai`, model `qwen2.5-omni`).
- Funded keys produced TEE-verified plans end to end, including the
  independent browser-side EIP-191 signer verification against the
  on-chain acknowledged signer.
- Unfunded or invalid keys failed exactly as they should: `402
  Insufficient balance` and `401 Invalid key` — both now caught by the
  intent box's **live one-token probe** before a user can prompt, with the
  specific reason shown in the preflight checklist.

### Hedera

- All settlement ran on a real testnet operator account. Over the weekend
  the operator was **drained to zero twice and refilled** (portal faucet /
  re-dispense), which validated the failure modes as thoroughly as the
  happy path: the preflight now checks the **live mirror balance** against
  the ~90 HBAR a market run fronts and refuses to start runs it cannot
  afford.
- Dozens of full market runs settled with atomic NATA-for-claim-NFT swaps,
  co-signed by buyer agents and sellers, every one replayable on HashScan
  from payer-authenticated HCS topics.
- The infrastructure (payment token, claim NFT collection, seller
  accounts, topics) bootstraps automatically from any operator: a fresh
  operator account recreates the whole marketplace with
  `npm run hedera:setup`.

### World

- Agent registration resolves against the **canonical AgentBook contract
  on World Chain**. The negative path is verified live: an unregistered
  wallet is refused ("not backed by a verified human") via a real
  on-chain lookup — bots cannot pass by construction.
- The in-product flow at `/world` performs the same registration the
  AgentKit CLI does (nonce from the contract, World ID bridge session, QR
  scanned in World App, proof relayed on-chain), with the identity key
  generated and kept in the browser.
- Sybil behavior was validated on testnet with the gateway: many wallets
  backed by one human collapse into a single allocation per protected
  auction (enrollment rejections plus settlement-time blocks, all logged
  by the job API).

## Network impact (measured, not estimated)

Agentic commerce is transaction-dense by construction: every plan mints
budget, funds scoped agent accounts, opens per-listing HCS topics, streams
authenticated bids, and settles with atomic swaps. Measured from real
testnet runs (all replayable via the operator's history on HashScan,
account `0.0.9695863`):

**The optimized judge profile for one $200 date plan (4 categories and 3
scoped rival agents) was repeated end to end in 53.0 and 50.0 seconds:**

- **7 pre-warmed Hedera agent accounts** — fresh mandates and funding, with no
  account creation on the judge-run critical path
- **8 fresh HCS topics** — one per live scarce listing, each with its own
  submit key
- **30 consensus messages** in the 50.0-second run — payer-authenticated
  listings, bids, closes, authorizations, and settlements
- **6 atomic swaps and 6 claim-NFT mints** — four purchases for the user and
  two for rival agents
- **4/4 requested user categories settled**, **7/7 agent wallets reconciled**,
  and **8/8 topics replay-verified** before the job reported `done`
- **2 protected listings refused the unverified rival before bidding**, while
  the human-backed paths continued normally

The earlier stress profile used 13 agents and 16 topics. The judge profile
keeps the same HTS atomic settlement, HCS authentication, seller policy, World
gating, and Mirror replay checks while moving reusable account provisioning to
setup and scoping each mock rival to one category.

## External feedback

Beyond our own testing, we walked the full flow with an experienced
builder from the ecosystem (outside the team) during the hackathon. The
reactions worth recording:

- the **core idea resonated** — private intent driving compartmentalized
  buyer agents was immediately understood as a real gap in agent commerce,
  not a demo gimmick;
- the **UI was called out as polished** — the intent box, live auction
  view, and verification receipts read as a product, not a prototype;
- surprise at the **scope achieved in the time available** — a TEE-planned,
  ledger-settled, human-gated marketplace across three sponsor stacks in
  one weekend.

Qualitative, sample size of one — but it was our first cold exposure to
someone who hadn't watched it being built, and nothing in the flow needed
explaining twice.

## Demo day

We will provide, ready to use:

- a **funded 0G Router key** held by the hosted coordinator (local development
  can still use browser-only BYOK),
- a **funded Hedera testnet operator** (loaded by the local coordinator;
  never exposed to the browser),
- a **World ID-approved identity agent** (already registered in the
  AgentBook, visible at `/world`).

The preflight checklist on the home page shows all three statuses live —
0G verified by an actual inference, Hedera by an actual balance lookup —
so "it works" is displayed, not asserted.

## Try it yourself

Any judge can swap in their own credentials; nothing is hardcoded to ours:

1. **0G** — create a key at [pc.0g.ai](https://pc.0g.ai) (deposit a small
   amount of OG; ~0.001 OG per plan) and paste it into the sidebar. The
   live probe will verify it within seconds.
2. **Hedera** — create a free testnet account at
   [portal.hedera.com](https://portal.hedera.com), put
   `HEDERA_OPERATOR_ID` / `HEDERA_OPERATOR_KEY` in `.env`, and run
   `npm run hedera:setup` once (the faucet at portal.hedera.com/faucet
   dispenses 100 HBAR daily; a market run fronts ~90 and sweeps most of it
   back).
3. **World** — open `/world` and scan the QR with your own World App. One
   Face ID tap registers a fresh identity agent against your anonymous
   World ID; your agents are then human-backed for one-per-human listings.

Every claim in the demo is independently checkable while it runs: plans
carry an EIP-191 TEE receipt verified in-browser, auctions and settlements
link to HashScan, and agent registrations link to WorldScan.
