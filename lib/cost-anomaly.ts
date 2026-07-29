import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  type GetCostAndUsageResponse,
} from "@aws-sdk/client-cost-explorer";
import type { AwsEnvironmentConfig } from "./aws-config";
import type {
  CostAnomalyReport,
  CostDriver,
  CostIncreaseDetail,
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
  if (baseline === null || baseline <= 0) {
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

function indexedCosts(
  items: DailyServiceCost[],
  keyFor: (item: DailyServiceCost) => string,
) {
  const index = new Map<string, number>();
  for (const item of items) {
    const key = keyFor(item);
    index.set(key, (index.get(key) ?? 0) + item.costUsd);
  }
  return index;
}

export function costReportMinimumIntervalMs() {
  const seconds = Number(
    process.env.CLOUDBOARD_COST_REPORT_MIN_INTERVAL_SECONDS?.trim() || "300",
  );
  const bounded = Number.isFinite(seconds)
    ? Math.min(86_400, Math.max(60, Math.floor(seconds)))
    : 300;
  return bounded * 1_000;
}

function costDrivers(
  current: DailyCostPoint,
  baselinePoints: DailyCostPoint[],
  detailByUsageType: boolean,
): CostDriver[] {
  const keyFor = (item: DailyServiceCost) =>
    detailByUsageType
      ? `${item.service}\u0000${item.usageType ?? ""}`
      : item.service;
  const baselineIndexes = baselinePoints.map(
    (point) => indexedCosts(point.services, keyFor),
  );
  const currentIndex = indexedCosts(current.services, keyFor);
  const labels = new Map<string, DailyServiceCost>();
  for (const point of baselinePoints) {
    for (const item of point.services) labels.set(keyFor(item), item);
  }
  for (const item of current.services) labels.set(keyFor(item), item);
  const keys = new Set([
    ...currentIndex.keys(),
    ...baselineIndexes.flatMap((index) => [...index.keys()]),
  ]);
  return [...keys]
    .map((key) => {
      const currentCost = currentIndex.get(key) ?? 0;
      const item = labels.get(key)!;
      const baselineCost = median(
        baselineIndexes.map((index) => index.get(key) ?? 0),
      );
      return {
        service: item.service,
        usageType: detailByUsageType ? item.usageType : null,
        costUsd: rounded(currentCost),
        baselineCostUsd:
          baselineCost === null ? null : rounded(baselineCost),
        baselineOccurrences: baselineIndexes.filter((index) => index.has(key))
          .length,
        changeUsd:
          baselineCost === null
            ? null
            : rounded(currentCost - baselineCost),
      };
    })
    .sort(
      (left, right) =>
        (right.changeUsd ?? right.costUsd) -
        (left.changeUsd ?? left.costUsd),
    );
}

function costIncreases(drivers: CostDriver[]): CostIncreaseDetail[] {
  return drivers
    .filter(
      (driver): driver is CostDriver & {
        baselineCostUsd: number;
        changeUsd: number;
      } =>
        driver.baselineCostUsd !== null &&
        driver.changeUsd !== null &&
        driver.changeUsd > 0,
    )
    .map((driver) => ({
      service: driver.service,
      usageType: driver.usageType,
      basisCostUsd: driver.costUsd,
      weekdayMedianCostUsd: driver.baselineCostUsd,
      increaseUsd: driver.changeUsd,
      increasePercentage: percentageChange(
        driver.costUsd,
        driver.baselineCostUsd,
      ),
      isNew: driver.baselineOccurrences === 0,
    }));
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
  const serviceDrivers = costDrivers(current, baselinePoints, false);
  const detailedDrivers = costDrivers(current, baselinePoints, true);
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
    costDetailsVersion: 1,
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
    topDrivers: serviceDrivers.slice(0, 5),
    costIncreases: hasEnoughData ? costIncreases(detailedDrivers) : [],
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
  const deadline = Date.now() + 60_000;
  const requestSignal = () =>
    AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  let nextPageToken: string | undefined;

  // Fetch cheap daily totals first. Detailed SERVICE x USAGE_TYPE data is only
  // needed for the selected basis date and its four weekday baselines.
  do {
    const response = await client.send(
      new GetCostAndUsageCommand({
        TimePeriod: costQueryWindow(now),
        Granularity: "DAILY",
        Metrics: [metric],
        NextPageToken: nextPageToken,
      }),
      { abortSignal: requestSignal() },
    );
    for (const result of response.ResultsByTime ?? []) {
      const date = result.TimePeriod?.Start;
      if (!date) {
        continue;
      }
      points.set(date, {
        date,
        costUsd: amount(result.Total?.[metric]?.Amount),
        estimated: result.Estimated !== false,
        services: [],
      });
    }
    nextPageToken = response.NextPageToken;
  } while (nextPageToken);

  const expectedBasisDate = costBasisDate(now);
  const basisDate = [...points.keys()]
    .filter((date) => date <= expectedBasisDate)
    .sort((left, right) => left.localeCompare(right))
    .at(-1);
  if (!basisDate) return [];

  const detailDates = [0, 7, 14, 21, 28]
    .map((days) => shiftDate(basisDate, -days))
    .filter((date) => points.has(date));
  for (const date of detailDates) {
    const services = new Map<string, DailyServiceCost>();
    nextPageToken = undefined;
    do {
      const response: GetCostAndUsageResponse = await client.send(
        new GetCostAndUsageCommand({
          TimePeriod: { Start: date, End: shiftDate(date, 1) },
          Granularity: "DAILY",
          Metrics: [metric],
          GroupBy: [
            { Type: "DIMENSION", Key: "SERVICE" },
            { Type: "DIMENSION", Key: "USAGE_TYPE" },
          ],
          NextPageToken: nextPageToken,
        }),
        { abortSignal: requestSignal() },
      );
      for (const result of response.ResultsByTime ?? []) {
        for (const group of result.Groups ?? []) {
          const service = group.Keys?.[0];
          const usageType = group.Keys?.[1] || null;
          if (!service) continue;

          const key = `${service}\u0000${usageType ?? ""}`;
          const existing = services.get(key);
          services.set(key, {
            service,
            usageType,
            costUsd:
              (existing?.costUsd ?? 0) +
              amount(group.Metrics?.[metric]?.Amount),
          });
        }
      }
      nextPageToken = response.NextPageToken;
    } while (nextPageToken);

    const point = points.get(date);
    if (point) {
      point.services = [...services.values()];
      point.costUsd = point.services.reduce(
        (sum, item) => sum + item.costUsd,
        0,
      );
    }
  }

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
