import assert from "node:assert/strict";
import test from "node:test";
import { tomorrowInCity } from "../src/time";

test("tomorrow is computed in the destination market's calendar", () => {
  // Tokyo has already crossed midnight, so its "tomorrow" is one calendar
  // day later than Lisbon's at this instant.
  assert.equal(
    tomorrowInCity("tokyo", new Date("2026-07-25T22:30:00Z")),
    "2026-07-27",
  );

  // New York is still on the previous date at this instant.
  assert.equal(
    tomorrowInCity("newyork", new Date("2026-07-25T00:30:00Z")),
    "2026-07-25",
  );
});
