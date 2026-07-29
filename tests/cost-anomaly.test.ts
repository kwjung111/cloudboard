import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeDailyCosts,
  costBasisDate,
  costQueryWindow,
} from "../lib/cost-anomaly";
import type { DailyCostPoint } from "../lib/cloudboard";

function point(
  date: string,
  costUsd: number,
  estimated = false,
  service = "Amazon Elastic Compute Cloud - Compute",
): DailyCostPoint {
  return {
    date,
    costUsd,
    estimated,
    services: [{ service, costUsd }],
  };
}

test("uses the KST T-2 date even when newer estimated data exists", () => {
  const report = analyzeDailyCosts(
    { id: "dev", name: "Development" },
    [
      point("2026-06-29", 100),
      point("2026-07-06", 120),
      point("2026-07-13", 110),
      point("2026-07-20", 130),
      point("2026-07-25", 90),
      point("2026-07-26", 100),
      point("2026-07-27", 180, true),
      point("2026-07-28", 999, true),
    ],
    { relativePercentage: 20, absoluteUsd: 50 },
    new Date("2026-07-29T06:00:00.000Z"),
  );

  assert.ok(report);
  assert.equal(report.basisDate, "2026-07-27");
  assert.equal(report.expectedBasisDate, "2026-07-27");
  assert.equal(report.dataStatus, "ready");
  assert.equal(report.weekdayMedianUsd, 115);
  assert.equal(report.weekdayChangeUsd, 65);
  assert.equal(report.costIsEstimated, true);
  assert.equal(report.status, "anomaly");
  assert.equal(report.previousBasisDate, "2026-07-26");
  assert.equal(report.previousBasisChangeUsd, 80);
  assert.equal(report.freshnessDays, 2);
});

test("uses the same KST T-2 basis at 06:00 and during a manual afternoon run", () => {
  const scheduled = new Date("2026-07-28T21:00:00.000Z");
  const manual = new Date("2026-07-29T06:00:00.000Z");

  assert.equal(costBasisDate(scheduled), "2026-07-27");
  assert.equal(costBasisDate(manual), "2026-07-27");
  assert.deepEqual(costQueryWindow(scheduled), {
    Start: "2026-06-16",
    End: "2026-07-28",
  });
  assert.deepEqual(costQueryWindow(manual), {
    Start: "2026-06-16",
    End: "2026-07-28",
  });
});

test("does not use T-1 when no T-2 or older cost data exists", () => {
  const report = analyzeDailyCosts(
    { id: "dev", name: "Development" },
    [point("2026-07-28", 999, true)],
    { relativePercentage: 20, absoluteUsd: 50 },
    new Date("2026-07-29T06:00:00.000Z"),
  );

  assert.equal(report, null);
});

test("falls back to an older basis and marks AWS data as delayed", () => {
  const report = analyzeDailyCosts(
    { id: "dev", name: "Development" },
    [
      point("2026-06-28", 100),
      point("2026-07-05", 120),
      point("2026-07-12", 110),
      point("2026-07-19", 130),
      point("2026-07-26", 180),
    ],
    { relativePercentage: 20, absoluteUsd: 50 },
    new Date("2026-07-29T06:00:00.000Z"),
  );

  assert.ok(report);
  assert.equal(report.basisDate, "2026-07-26");
  assert.equal(report.expectedBasisDate, "2026-07-27");
  assert.equal(report.dataStatus, "delayed");
  assert.equal(report.weekdayMedianUsd, 115);
  assert.equal(report.weekdayChangeUsd, 65);
  assert.equal(report.status, "anomaly");
  assert.equal(report.previousBasisDate, "2026-07-19");
  assert.equal(report.previousBasisChangeUsd, 50);
  assert.equal(report.freshnessDays, 3);
});

test("handles KST month and year boundaries", () => {
  assert.equal(
    costBasisDate(new Date("2026-12-31T21:00:00.000Z")),
    "2026-12-30",
  );
  assert.equal(
    costBasisDate(new Date("2028-02-29T15:00:00.000Z")),
    "2028-02-28",
  );
});

test("requires both relative and absolute thresholds", () => {
  const report = analyzeDailyCosts(
    { id: "prd", name: "Production" },
    [
      point("2026-06-28", 100),
      point("2026-07-05", 100),
      point("2026-07-12", 100),
      point("2026-07-19", 100),
      point("2026-07-26", 130),
    ],
    { relativePercentage: 20, absoluteUsd: 50 },
    new Date("2026-07-28T00:00:00.000Z"),
  );

  assert.ok(report);
  assert.equal(report.weekdayChangePercentage, 30);
  assert.equal(report.weekdayChangeUsd, 30);
  assert.equal(report.status, "normal");
});

test("reports insufficient data until at least two same weekdays exist", () => {
  const report = analyzeDailyCosts(
    { id: "dev", name: "Development" },
    [point("2026-07-19", 100), point("2026-07-26", 200)],
    { relativePercentage: 20, absoluteUsd: 50 },
    new Date("2026-07-28T00:00:00.000Z"),
  );

  assert.ok(report);
  assert.equal(report.status, "insufficient-data");
  assert.deepEqual(report.baselineDates, ["2026-07-19"]);
});

test("ranks services by increase from their weekday median", () => {
  const baselineDates = [
    "2026-06-28",
    "2026-07-05",
    "2026-07-12",
    "2026-07-19",
  ];
  const baselines = baselineDates.map((date) => ({
    date,
    costUsd: 110,
    estimated: false,
    services: [
      { service: "EC2", costUsd: 80 },
      { service: "RDS", costUsd: 30 },
    ],
  }));
  const report = analyzeDailyCosts(
    { id: "prd", name: "Production" },
    [
      ...baselines,
      {
        date: "2026-07-26",
        costUsd: 200,
        estimated: false,
        services: [
          { service: "EC2", costUsd: 100 },
          { service: "RDS", costUsd: 100 },
        ],
      },
    ],
    { relativePercentage: 20, absoluteUsd: 50 },
    new Date("2026-07-28T00:00:00.000Z"),
  );

  assert.ok(report);
  assert.equal(report.topDrivers[0].service, "RDS");
  assert.equal(report.topDrivers[0].changeUsd, 70);
});
