import assert from "node:assert/strict";
import test from "node:test";
import {
  MockAgentBook,
  WorldGateway,
  type AuctionPass,
} from "../src/server/world-gateway";

function setup() {
  const book = new MockAgentBook();
  book.registerAgent("0xAliceIdentity", "alice");
  book.registerAgent("0xScalperA", "scalper");
  book.registerAgent("0xScalperB", "scalper");
  book.registerAgent("0xBobIdentity", "bob");
  return { book, gateway: new WorldGateway(book) };
}

test("a scalper's many agents collapse into one allocation per auction", async () => {
  const { gateway } = setup();

  const first = await gateway.enroll({
    auctionId: "item_cinema_rowE",
    identityAgent: "0xScalperA",
    leafWallet: "0.0.1001",
  });
  assert.ok(first.ok);

  // Nine more wallets, same human — including via a second registered
  // agent address backed by the same person.
  let rejected = 0;
  for (let i = 0; i < 9; i++) {
    const attempt = await gateway.enroll({
      auctionId: "item_cinema_rowE",
      identityAgent: i % 2 === 0 ? "0xScalperA" : "0xScalperB",
      leafWallet: `0.0.10${i + 2}`,
    });
    if (!attempt.ok) rejected += 1;
  }
  assert.equal(rejected, 9);
  assert.equal(gateway.stats.passesIssued, 1);
  assert.equal(gateway.stats.sybilRejections, 9);

  // A different human still gets in.
  const bob = await gateway.enroll({
    auctionId: "item_cinema_rowE",
    identityAgent: "0xBobIdentity",
    leafWallet: "0.0.2001",
  });
  assert.ok(bob.ok);
});

test("nullifiers are auction-scoped: colluding sellers cannot correlate", async () => {
  const { gateway } = setup();
  const cinema = await gateway.enroll({
    auctionId: "item_cinema_rowE",
    identityAgent: "0xAliceIdentity",
    leafWallet: "0.0.3001",
  });
  const dinner = await gateway.enroll({
    auctionId: "item_dinner_window",
    identityAgent: "0xAliceIdentity",
    leafWallet: "0.0.3002",
  });
  assert.ok(cinema.ok && dinner.ok);
  assert.ok(cinema.pass && dinner.pass);
  // Same human, two auctions: different nullifiers, and neither is the humanId.
  assert.notEqual(cinema.pass.nullifier, dinner.pass.nullifier);
});

test("unregistered agents are refused: bots do not pass", async () => {
  const { gateway } = setup();
  const bot = await gateway.enroll({
    auctionId: "item_cinema_rowE",
    identityAgent: "0xUnregisteredBot",
    leafWallet: "0.0.4001",
  });
  assert.equal(bot.ok, false);
  assert.match(bot.reason ?? "", /not backed by a verified human/);
  assert.equal(gateway.stats.notHumanBacked, 1);
});

test("passes are bound to auction and wallet, and tamper-evident", async () => {
  const { gateway } = setup();
  const enrolled = await gateway.enroll({
    auctionId: "item_cinema_rowE",
    identityAgent: "0xAliceIdentity",
    leafWallet: "0.0.5001",
  });
  assert.ok(enrolled.ok && enrolled.pass);
  const pass = enrolled.pass;

  assert.ok(gateway.verifyPass(pass, "item_cinema_rowE", "0.0.5001"));
  // Wrong auction, wrong wallet, or edited amount: all refused.
  assert.equal(gateway.verifyPass(pass, "item_dinner_window", "0.0.5001"), false);
  assert.equal(gateway.verifyPass(pass, "item_cinema_rowE", "0.0.9999"), false);
  const forged: AuctionPass = { ...pass, quota: 99 };
  assert.equal(gateway.verifyPass(forged, "item_cinema_rowE", "0.0.5001"), false);
});
