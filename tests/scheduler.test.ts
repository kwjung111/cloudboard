import assert from "node:assert/strict";
import test from "node:test";
import {
  nextRunDelay,
  runReport,
} from "../worker/daily-cost-scheduler.mjs";

test("schedules the next report for 06:00 Asia/Seoul", () => {
  const beforeSix = new Date("2026-07-29T20:00:00.000Z");
  const afterSix = new Date("2026-07-29T22:00:00.000Z");

  assert.equal(nextRunDelay(beforeSix), 60 * 60 * 1_000);
  assert.equal(nextRunDelay(afterSix), 23 * 60 * 60 * 1_000);
});

test("aborts a report endpoint that does not respond", async () => {
  const hangingFetch = (
    _url: string,
    init: { signal: AbortSignal },
  ): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        "abort",
        () => reject(init.signal.reason),
        { once: true },
      );
    });

  const keepEventLoopAlive = setTimeout(() => undefined, 100);
  try {
    await assert.rejects(
      runReport("ai-audit-report", "http://cloudboard.test", hangingFetch, 10),
      (error: unknown) =>
        error instanceof Error &&
        (error.name === "TimeoutError" || /timeout/i.test(error.message)),
    );
  } finally {
    clearTimeout(keepEventLoopAlive);
  }
});
