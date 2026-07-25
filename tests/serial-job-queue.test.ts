import assert from "node:assert/strict";
import test from "node:test";
import { SerialJobQueue } from "../src/server/serial-job-queue";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("serial jobs queue instead of rejecting and start in FIFO order", async () => {
  const queue = new SerialJobQueue();
  const first = deferred();
  const second = deferred();
  const third = deferred();
  const started: string[] = [];
  const positions = new Map<string, number>();
  const errors: unknown[] = [];

  const enqueue = (
    name: string,
    execution: Promise<void>,
  ) =>
    queue.enqueue({
      onStart: () => started.push(name),
      onPosition: (position) => positions.set(name, position),
      run: () => execution,
      onError: (error) => errors.push(error),
    });

  enqueue("first", first.promise);
  enqueue("second", second.promise);
  enqueue("third", third.promise);
  assert.deepEqual(started, ["first"]);
  assert.equal(positions.get("second"), 1);
  assert.equal(positions.get("third"), 2);

  first.resolve();
  await turn();
  assert.deepEqual(started, ["first", "second"]);
  assert.equal(positions.get("third"), 1);

  second.resolve();
  await turn();
  assert.deepEqual(started, ["first", "second", "third"]);
  third.resolve();
  await turn();
  assert.deepEqual(errors, []);
});

test("a failed serial job cannot strand the next queued run", async () => {
  const queue = new SerialJobQueue();
  const started: string[] = [];
  const errors: string[] = [];
  const next = deferred();

  queue.enqueue({
    onStart: () => started.push("failed"),
    onPosition: () => {},
    run: async () => {
      throw new Error("network failed");
    },
    onError: (error) =>
      errors.push(error instanceof Error ? error.message : String(error)),
  });
  queue.enqueue({
    onStart: () => started.push("next"),
    onPosition: () => {},
    run: () => next.promise,
    onError: () => {},
  });

  await turn();
  assert.deepEqual(errors, ["network failed"]);
  assert.deepEqual(started, ["failed", "next"]);
  next.resolve();
});

test("a start-hook failure cannot strand the next queued run", async () => {
  const queue = new SerialJobQueue();
  const started: string[] = [];
  const errors: string[] = [];

  queue.enqueue({
    onStart: () => {
      throw new Error("could not enter running state");
    },
    onPosition: () => {},
    run: async () => {
      throw new Error("must not run");
    },
    onError: (error) =>
      errors.push(error instanceof Error ? error.message : String(error)),
  });
  queue.enqueue({
    onStart: () => started.push("next"),
    onPosition: () => {},
    run: async () => {},
    onError: () => {},
  });

  await turn();
  assert.deepEqual(errors, ["could not enter running state"]);
  assert.deepEqual(started, ["next"]);
});
