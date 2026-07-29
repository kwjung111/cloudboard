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
    services: [{ service, usageType: null, costUsd }],
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
  assert.deepEqual(report.costIncreases, []);
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
      { service: "EC2", usageType: null, costUsd: 80 },
      { service: "RDS", usageType: null, costUsd: 30 },
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
          { service: "EC2", usageType: null, costUsd: 100 },
          { service: "RDS", usageType: null, costUsd: 100 },
        ],
      },
    ],
    { relativePercentage: 20, absoluteUsd: 50 },
    new Date("2026-07-28T00:00:00.000Z"),
  );

  assert.ok(report);
  assert.equal(report.topDrivers[0].service, "RDS");
  assert.equal(report.topDrivers[0].changeUsd, 70);
  assert.deepEqual(
    report.costIncreases.map((item) => ({
      service: item.service,
      increaseUsd: item.increaseUsd,
    })),
    [
      { service: "RDS", increaseUsd: 70 },
      { service: "EC2", increaseUsd: 20 },
    ],
  );
});

test("includes every increased service and treats a missing baseline service as zero", () => {
  const report = analyzeDailyCosts(
    { id: "prd", name: "Production" },
    [
      {
        date: "2026-07-05",
        costUsd: 100,
        estimated: false,
        services: [{ service: "EC2", usageType: null, costUsd: 100 }],
      },
      {
        date: "2026-07-12",
        costUsd: 110,
        estimated: false,
        services: [
          { service: "EC2", usageType: null, costUsd: 100 },
          { service: "RDS", usageType: null, costUsd: 10 },
        ],
      },
      {
        date: "2026-07-19",
        costUsd: 100,
        estimated: false,
        services: [{ service: "EC2", usageType: null, costUsd: 100 }],
      },
      {
        date: "2026-07-26",
        costUsd: 180,
        estimated: false,
        services: [
          { service: "EC2", usageType: null, costUsd: 120 },
          { service: "RDS", usageType: null, costUsd: 20 },
          { service: "AWS Lambda", usageType: null, costUsd: 40 },
        ],
      },
    ],
    { relativePercentage: 20, absoluteUsd: 50 },
    new Date("2026-07-28T00:00:00.000Z"),
  );

  assert.ok(report);
  assert.deepEqual(
    report.costIncreases.map((item) => ({
      service: item.service,
      baseline: item.weekdayMedianCostUsd,
      increase: item.increaseUsd,
    })),
    [
      { service: "AWS Lambda", baseline: 0, increase: 40 },
      { service: "EC2", baseline: 100, increase: 20 },
      { service: "RDS", baseline: 0, increase: 20 },
    ],
  );
  assert.equal(report.costIncreases[0].increasePercentage, null);
  assert.equal(report.costIncreases[0].isNew, true);
  assert.equal(
    report.costIncreases.find((item) => item.service === "RDS")?.isNew,
    false,
  );
});

test("keeps top drivers aggregated by service while details split usage types", () => {
  const baselineDates = ["2026-07-12", "2026-07-19"];
  const report = analyzeDailyCosts(
    { id: "prd", name: "Production" },
    [
      ...baselineDates.map((date) => ({
        date,
        costUsd: 100,
        estimated: false,
        services: [
          { service: "EC2", usageType: "BoxUsage:t3.large", costUsd: 70 },
          { service: "EC2", usageType: "NatGateway-Hours", costUsd: 30 },
        ],
      })),
      {
        date: "2026-07-26",
        costUsd: 180,
        estimated: false,
        services: [
          { service: "EC2", usageType: "BoxUsage:t3.large", costUsd: 120 },
          { service: "EC2", usageType: "NatGateway-Hours", costUsd: 60 },
        ],
      },
    ],
    { relativePercentage: 20, absoluteUsd: 50 },
    new Date("2026-07-28T00:00:00.000Z"),
  );

  assert.ok(report);
  assert.equal(report.topDrivers.length, 1);
  assert.equal(report.topDrivers[0].service, "EC2");
  assert.equal(report.topDrivers[0].usageType, null);
  assert.equal(report.topDrivers[0].changeUsd, 80);
  assert.deepEqual(
    report.costIncreases.map((item) => item.usageType),
    ["BoxUsage:t3.large", "NatGateway-Hours"],
  );
});

test("does not calculate a percentage from a negative baseline", () => {
  const report = analyzeDailyCosts(
    { id: "prd", name: "Production" },
    [
      point("2026-07-12", -100),
      point("2026-07-19", -100),
      point("2026-07-26", -20),
    ],
    { relativePercentage: 20, absoluteUsd: 50 },
    new Date("2026-07-28T00:00:00.000Z"),
  );

  assert.ok(report);
  assert.equal(report.weekdayChangeUsd, 80);
  assert.equal(report.weekdayChangePercentage, null);
  assert.equal(report.costIncreases[0].increaseUsd, 80);
  assert.equal(report.costIncreases[0].increasePercentage, null);
  assert.equal(report.costIncreases[0].isNew, false);
});

test("counts a disappearing credit as a cost increase", () => {
  const baseline = (date: string): DailyCostPoint => ({
    date,
    costUsd: -100,
    estimated: false,
    services: [
      { service: "Credits", usageType: "EnterpriseCredit", costUsd: -100 },
    ],
  });
  const report = analyzeDailyCosts(
    { id: "prd", name: "Production" },
    [
      baseline("2026-07-12"),
      baseline("2026-07-19"),
      {
        date: "2026-07-26",
        costUsd: 0,
        estimated: false,
        services: [],
      },
    ],
    { relativePercentage: 20, absoluteUsd: 50 },
    new Date("2026-07-28T00:00:00.000Z"),
  );

  assert.ok(report);
  assert.equal(report.costIncreases[0].service, "Credits");
  assert.equal(report.costIncreases[0].basisCostUsd, 0);
  assert.equal(report.costIncreases[0].increaseUsd, 100);
  assert.equal(report.costIncreases[0].isNew, false);
});
