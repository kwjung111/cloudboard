import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from "@aws-sdk/client-cost-explorer";
import type { AwsEnvironmentConfig } from "./aws-config";
import type {
  CostAnomalyReport,
  CostDriver,
  DailyCostPoint,
  DailyServiceCost,
} from "./cloudboard";

const dayMs = 86_400_000;
const koreaOffsetMs = 9 * 60 * 60 * 1_000;
const metric = "NetAmortizedCost" as const;

export interface CostAnomalyThresholds {
  relativePercentage: number;
  absoluteUsd: number;
}

function rounded(value: number) {
  return Math.round(value * 100) / 100;
}

function amount(value: string | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function shiftDate(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return dateOnly(date);
}

function koreaDateOnly(date: Date) {
  return dateOnly(new Date(date.getTime() + koreaOffsetMs));
}

export function costBasisDate(now = new Date()) {
  return shiftDate(koreaDateOnly(now), -2);
}

export function costFreshnessDays(basisDate: string, now = new Date()) {
  return Math.max(0, daysBetween(koreaDateOnly(now), basisDate));
}

function daysBetween(later: string, earlier: string) {
  return Math.round(
    (new Date(`${later}T00:00:00.000Z`).getTime() -
      new Date(`${earlier}T00:00:00.000Z`).getTime()) /
      dayMs,
  );
}

function percentageChange(current: number, baseline: number | null) {
  if (baseline === null || baseline === 0) {
    return null;
  }
  return rounded(((current - baseline) / baseline) * 100);
}

function median(values: number[]) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function thresholdFromEnvironment(
  name: "RELATIVE_PERCENTAGE" | "ABSOLUTE_USD",
  fallback: number,
) {
  const configured = Number(process.env[`CLOUDBOARD_COST_ANOMALY_${name}`]);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : fallback;
}

export function costAnomalyThresholds(): CostAnomalyThresholds {
  return {
    relativePercentage: thresholdFromEnvironment(
      "RELATIVE_PERCENTAGE",
      20,
    ),
    absoluteUsd: thresholdFromEnvironment("ABSOLUTE_USD", 100),
  };
}

function topDrivers(
  current: DailyCostPoint,
  baselinePoints: DailyCostPoint[],
): CostDriver[] {
  const services = new Map<string, number[]>();
  for (const point of baselinePoints) {
    for (const item of point.services) {
      const values = services.get(item.service) ?? [];
      values.push(item.costUsd);
      services.set(item.service, values);
    }
  }

  return current.services
    .map((item) => {
      const baselineCost = median(services.get(item.service) ?? []);
      return {
        service: item.service,
        costUsd: rounded(item.costUsd),
        baselineCostUsd:
          baselineCost === null ? null : rounded(baselineCost),
        changeUsd:
          baselineCost === null
            ? null
            : rounded(item.costUsd - baselineCost),
      };
    })
    .sort(
      (left, right) =>
        (right.changeUsd ?? right.costUsd) -
        (left.changeUsd ?? left.costUsd),
    )
    .slice(0, 5);
}

export function analyzeDailyCosts(
  environment: Pick<AwsEnvironmentConfig, "id" | "name">,
  points: DailyCostPoint[],
  thresholds = costAnomalyThresholds(),
  now = new Date(),
): CostAnomalyReport | null {
  const expectedBasisDate = costBasisDate(now);
  const completedDays = points
    .filter((point) => point.date <= expectedBasisDate)
    .sort((left, right) => left.date.localeCompare(right.date));
  const current = completedDays.at(-1);
  if (!current) {
    return null;
  }

  const byDate = new Map(completedDays.map((point) => [point.date, point]));
  const baselinePoints = [7, 14, 21, 28]
    .map((days) => {
      const date = new Date(`${current.date}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() - days);
      return byDate.get(dateOnly(date));
    })
    .filter((point): point is DailyCostPoint => Boolean(point));
  const weekdayMedian = median(
    baselinePoints.map((point) => point.costUsd),
  );
  const previous = completedDays.at(-2) ?? null;
  const weekdayChange =
    weekdayMedian === null ? null : rounded(current.costUsd - weekdayMedian);
  const weekdayChangePercentage = percentageChange(
    current.costUsd,
    weekdayMedian,
  );
  const previousBasisChange = previous
    ? rounded(current.costUsd - previous.costUsd)
    : null;
  const hasEnoughData = baselinePoints.length >= 2;
  const isAnomaly =
    hasEnoughData &&
    weekdayChange !== null &&
    weekdayChangePercentage !== null &&
    weekdayChange >= thresholds.absoluteUsd &&
    weekdayChangePercentage >= thresholds.relativePercentage;
  const status = !hasEnoughData
    ? "insufficient-data"
    : isAnomaly
      ? "anomaly"
      : "normal";
  const message =
    status === "anomaly"
      ? `동일 요일 기준보다 ${rounded(weekdayChange ?? 0)} USD 증가했습니다.`
      : status === "insufficient-data"
        ? "동일 요일 기준을 만들기 위한 완료 데이터가 아직 부족합니다."
        : "설정한 증가율과 증가액 기준을 동시에 넘지 않았습니다.";

  return {
    environmentId: environment.id,
    environmentName: environment.name,
    generatedAt: now.toISOString(),
    expectedBasisDate,
    basisDate: current.date,
    dataStatus: current.date === expectedBasisDate ? "ready" : "delayed",
    freshnessDays: costFreshnessDays(current.date, now),
    costIsEstimated: current.estimated,
    metric,
    status,
    totalCostUsd: rounded(current.costUsd),
    weekdayMedianUsd:
      weekdayMedian === null ? null : rounded(weekdayMedian),
    weekdayChangeUsd: weekdayChange,
    weekdayChangePercentage,
    previousBasisDate: previous?.date ?? null,
    previousBasisCostUsd:
      previous === null ? null : rounded(previous.costUsd),
    previousBasisChangeUsd: previousBasisChange,
    previousBasisChangePercentage: percentageChange(
      current.costUsd,
      previous?.costUsd ?? null,
    ),
    baselineDates: baselinePoints.map((point) => point.date),
    thresholds,
    topDrivers: topDrivers(current, baselinePoints),
    message,
  };
}

export function costQueryWindow(now = new Date()) {
  // KST today -> T-2 basis -> T-1 Cost Explorer End (exclusive).
  const end = shiftDate(costBasisDate(now), 1);
  const start = shiftDate(end, -42);
  return { Start: start, End: end };
}

export async function fetchDailyCosts(
  config: AwsEnvironmentConfig,
  now = new Date(),
): Promise<DailyCostPoint[]> {
  const client = new CostExplorerClient({
    region: "us-east-1",
    credentials: config.credentials,
    maxAttempts: 2,
  });
  const points = new Map<string, DailyCostPoint>();
  let nextPageToken: string | undefined;

  do {
    const response = await client.send(
      new GetCostAndUsageCommand({
        TimePeriod: costQueryWindow(now),
        Granularity: "DAILY",
        Metrics: [metric],
        GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
        NextPageToken: nextPageToken,
      }),
    );
    for (const result of response.ResultsByTime ?? []) {
      const date = result.TimePeriod?.Start;
      if (!date) {
        continue;
      }
      const current = points.get(date) ?? {
        date,
        costUsd: 0,
        estimated: result.Estimated !== false,
        services: [],
      };
      const services = new Map(
        current.services.map((item) => [item.service, item.costUsd]),
      );
      for (const group of result.Groups ?? []) {
        const service = group.Keys?.[0];
        if (!service) {
          continue;
        }
        services.set(
          service,
          (services.get(service) ?? 0) +
            amount(group.Metrics?.[metric]?.Amount),
        );
      }
      const mergedServices: DailyServiceCost[] = [...services].map(
        ([service, costUsd]) => ({ service, costUsd }),
      );
      points.set(date, {
        date,
        costUsd: mergedServices.reduce(
          (sum, item) => sum + item.costUsd,
          0,
        ),
        estimated: current.estimated || result.Estimated !== false,
        services: mergedServices,
      });
    }
    nextPageToken = response.NextPageToken;
  } while (nextPageToken);

  return [...points.values()].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
}

export async function generateCostAnomalyReport(
  config: AwsEnvironmentConfig,
  now = new Date(),
) {
  const points = await fetchDailyCosts(config, now);
  return analyzeDailyCosts(config, points, costAnomalyThresholds(), now);
}
