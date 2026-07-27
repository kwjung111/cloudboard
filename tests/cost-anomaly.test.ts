import assert from "node:assert/strict";
import test from "node:test";
import { analyzeDailyCosts } from "../lib/cost-anomaly";
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

test("uses the latest completed UTC date even when the month is estimated", () => {
  const report = analyzeDailyCosts(
    { id: "dev", name: "Development" },
    [
      point("2026-06-28", 100),
      point("2026-07-05", 120),
      point("2026-07-12", 110),
      point("2026-07-19", 130),
      point("2026-07-25", 90),
      point("2026-07-26", 180),
      point("2026-07-27", 190, true),
    ],
    { relativePercentage: 20, absoluteUsd: 50 },
    new Date("2026-07-28T00:00:00.000Z"),
  );

  assert.ok(report);
  assert.equal(report.basisDate, "2026-07-27");
  assert.equal(report.weekdayMedianUsd, null);
  assert.equal(report.weekdayChangeUsd, null);
  assert.equal(report.costIsEstimated, true);
  assert.equal(report.status, "insufficient-data");
  assert.equal(report.previousFinalizedDate, "2026-07-26");
  assert.equal(report.previousDayChangeUsd, 10);
  assert.equal(report.freshnessDays, 1);
});

test("uses the same-weekday median for an estimated current-month day", () => {
  const report = analyzeDailyCosts(
    { id: "dev", name: "Development" },
    [
      point("2026-06-28", 100),
      point("2026-07-05", 120, true),
      point("2026-07-12", 110, true),
      point("2026-07-19", 130, true),
      point("2026-07-25", 90, true),
      point("2026-07-26", 180, true),
    ],
    { relativePercentage: 20, absoluteUsd: 50 },
    new Date("2026-07-27T00:00:00.000Z"),
  );

  assert.ok(report);
  assert.equal(report.basisDate, "2026-07-26");
  assert.equal(report.weekdayMedianUsd, 115);
  assert.equal(report.weekdayChangeUsd, 65);
  assert.equal(report.status, "anomaly");
  assert.equal(report.previousFinalizedDate, "2026-07-25");
  assert.equal(report.previousDayChangeUsd, 90);
  assert.equal(report.costIsEstimated, true);
  assert.equal(report.freshnessDays, 1);
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
    new Date("2026-07-27T00:00:00.000Z"),
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
    new Date("2026-07-27T00:00:00.000Z"),
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
    new Date("2026-07-27T00:00:00.000Z"),
  );

  assert.ok(report);
  assert.equal(report.topDrivers[0].service, "RDS");
  assert.equal(report.topDrivers[0].changeUsd, 70);
});
