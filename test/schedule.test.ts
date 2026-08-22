import { describe, expect, it } from "vitest";
import { MAX_RETRY_ATTEMPTS, notifyDue, RETRY_INTERVAL_SECONDS } from "../src/schedule.ts";

// The deliver-lane scheduling spine is deliberately FLAT: a fixed 30s retry interval and a
// 10-attempt suspension cap. These pin the exact values every retrying mechanism (transition
// outbox, evidence publish, human-reply poll) and the suspension choke point are written against —
// a change here changes how long a broken cause retries before it flags.

describe("retry constants", () => {
  it("retries every 30 seconds, flat", () => {
    expect(RETRY_INTERVAL_SECONDS).toBe(30);
  });

  it("suspends after 10 failed attempts", () => {
    expect(MAX_RETRY_ATTEMPTS).toBe(10);
  });
});

describe("notifyDue", () => {
  it("always fires when never notified — null is not epoch 0", () => {
    expect(notifyDue(null, 3600, 1_000_000)).toBe(true);
    expect(notifyDue(undefined, 3600, 1_000_000)).toBe(true);
  });

  it("holds inside the throttle window, fires at and past it", () => {
    expect(notifyDue(1_000_000, 3600, 1_000_000 + 3599)).toBe(false);
    expect(notifyDue(1_000_000, 3600, 1_000_000 + 3600)).toBe(true);
    expect(notifyDue(1_000_000, 3600, 1_000_000 + 9999)).toBe(true);
  });

  it("is unit-agnostic (the updater passes milliseconds)", () => {
    const sixHoursMs = 6 * 60 * 60 * 1000;
    const now = 1_700_000_000_000;
    expect(notifyDue(now - sixHoursMs + 1, sixHoursMs, now)).toBe(false);
    expect(notifyDue(now - sixHoursMs, sixHoursMs, now)).toBe(true);
  });
});
