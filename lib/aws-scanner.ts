import {
  CostExplorerClient,
  GetReservationCoverageCommand,
  GetReservationUtilizationCommand,
  GetSavingsPlansCoverageCommand,
  GetSavingsPlansUtilizationCommand,
  GetSavingsPlansUtilizationDetailsCommand,
} from "@aws-sdk/client-cost-explorer";
import {
  DescribeInstancesCommand,
  DescribeReservedInstancesCommand,
  EC2Client,
  type DescribeInstancesCommandOutput,
} from "@aws-sdk/client-ec2";
import {
  DescribeCacheClustersCommand,
  DescribeReservedCacheNodesCommand,
  ElastiCacheClient,
  type DescribeCacheClustersCommandOutput,
  type DescribeReservedCacheNodesCommandOutput,
} from "@aws-sdk/client-elasticache";
import {
  DescribeDomainsCommand,
  DescribeReservedInstancesCommand as DescribeOpenSearchReservedInstancesCommand,
  ListDomainNamesCommand,
  OpenSearchClient,
  type DescribeReservedInstancesCommandOutput as DescribeOpenSearchReservedInstancesCommandOutput,
} from "@aws-sdk/client-opensearch";
import {
  DescribeDBInstancesCommand,
  DescribeReservedDBInstancesCommand,
  RDSClient,
  type DescribeDBInstancesCommandOutput,
  type DescribeReservedDBInstancesCommandOutput,
} from "@aws-sdk/client-rds";
import {
  DescribeClustersCommand,
  DescribeReservedNodesCommand,
  RedshiftClient,
  type DescribeClustersCommandOutput,
  type DescribeReservedNodesCommandOutput,
} from "@aws-sdk/client-redshift";
import {
  DescribeSavingsPlansCommand,
  SavingsplansClient,
  type DescribeSavingsPlansCommandOutput,
} from "@aws-sdk/client-savingsplans";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { AwsEnvironmentConfig } from "./aws-config";
import type {
  CommitmentDailyMetric,
  CommitmentMetricSet,
  CommitmentMetrics,
  CoverageLevel,
  EnvironmentReport,
  Finding,
  MetricValue,
  ReservationSummary,
  ResourceBreakdown,
  SavingsPlanSummary,
  SavingsPlansCoverageBreakdown,
  SavingsPlansServiceCoverage,
  ServiceCoverage,
  ServiceKey,
} from "./cloudboard";

interface InventoryResult {
  running: number;
  reserved: number;
  breakdown: ResourceBreakdown[];
  reservations: ReservationSummary[];
}

interface ServiceDefinition {
  key: ServiceKey;
  name: string;
  reservationServiceName: string | null;
}

const services: ServiceDefinition[] = [
  {
    key: "ec2",
    name: "Amazon EC2",
    reservationServiceName: "Amazon Elastic Compute Cloud - Compute",
  },
  {
    key: "rds",
    name: "Amazon RDS",
    reservationServiceName: "Amazon Relational Database Service",
  },
  {
    key: "elasticache",
    name: "Amazon ElastiCache",
    reservationServiceName: "Amazon ElastiCache",
  },
  {
    key: "opensearch",
    name: "Amazon OpenSearch",
    reservationServiceName: "Amazon Elasticsearch Service",
  },
  {
    key: "redshift",
    name: "Amazon Redshift",
    reservationServiceName: "Amazon Redshift",
  },
];

function asNumber(value: string | number | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toPercentage(value: string | undefined) {
  if (value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(100, Math.max(0, Math.round(parsed * 10) / 10))
    : null;
}

function toCurrency(value: string | undefined) {
  if (value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function coverageWindow() {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 30);
  return { start: formatDate(start), end: formatDate(end) };
}

function toIsoString(value: Date | undefined) {
  return value ? value.toISOString() : null;
}

function endFromDuration(start: Date | undefined, duration: number | undefined) {
  return start && duration
    ? new Date(start.getTime() + duration * 1_000).toISOString()
    : null;
}

function errorMessage(error: unknown) {
  const name =
    error instanceof Error
      ? error.name
      : typeof error === "object" && error && "name" in error
        ? String(error.name)
        : "";
  const code =
    typeof error === "object" && error && "code" in error
      ? String(error.code)
      : "";

  if (/AccessDenied|Unauthorized/i.test(name)) {
    return "조회 권한이 없습니다.";
  }
  if (/ExpiredToken/i.test(name)) {
    return "인증 토큰이 만료되었습니다.";
  }
  if (/InvalidClientToken|UnrecognizedClient|Credentials/i.test(name)) {
    return "AWS 자격 증명을 확인해 주세요.";
  }
  if (/Timeout|Networking|Fetch/i.test(name) || /^E(?:ACCES|CONN|HOST)/.test(code)) {
    return "AWS 연결 시간이 초과되었습니다.";
  }
  return "AWS 조회 중 오류가 발생했습니다.";
}

function metricFailure(error: unknown): MetricValue {
  const name =
    error instanceof Error
      ? error.name
      : typeof error === "object" && error && "name" in error
        ? String(error.name)
        : "";

  if (name === "DataUnavailableException") {
    return {
      value: null,
      status: "pending",
      message: "AWS 비용 데이터 집계 대기 중입니다.",
    };
  }

  return {
    value: null,
    status: "error",
    message: errorMessage(error),
  };
}

function metricValue(value: number | null): MetricValue {
  return value === null
    ? {
        value: null,
        status: "unavailable",
        message: "집계할 사용 데이터가 없습니다.",
      }
    : { value, status: "ready", message: null };
}

function pendingCommitmentUtilization(): MetricValue {
  return {
    value: null,
    status: "pending",
    message: "최근 30일 약정별 사용률을 집계하고 있습니다.",
  };
}

function emptyMetricSet(message: string): CommitmentMetricSet {
  const value = (): MetricValue => ({
    value: null,
    status: "unavailable",
    message,
  });
  return {
    coverage: value(),
    utilization: value(),
    netSavingsUsd: value(),
    unusedCommitmentUsd: value(),
    uncoveredOnDemandUsd: value(),
    daily: [],
  };
}

function failedMetricSet(error: unknown): CommitmentMetricSet {
  const failure = metricFailure(error);
  return {
    coverage: failure,
    utilization: { ...failure },
    netSavingsUsd: { ...failure },
    unusedCommitmentUsd: { ...failure },
    uncoveredOnDemandUsd: { ...failure },
    daily: [],
  };
}

function emptyCommitmentMetrics(): CommitmentMetrics {
  return {
    ri: emptyMetricSet("AWS 연결 후 조회됩니다."),
    savingsPlans: emptyMetricSet("AWS 연결 후 조회됩니다."),
  };
}

function mergeBreakdown(
  target: Map<string, ResourceBreakdown>,
  region: string,
  family: string,
  running: number,
  reserved: number,
) {
  const key = `${region}:${family}`;
  const current = target.get(key) ?? {
    region,
    family,
    running: 0,
    reserved: 0,
  };
  current.running += running;
  current.reserved += reserved;
  target.set(key, current);
}

function resultFromBreakdown(
  breakdown: Map<string, ResourceBreakdown>,
  reservations: ReservationSummary[],
) {
  const rows = [...breakdown.values()];
  return {
    running: rows.reduce((sum, row) => sum + row.running, 0),
    reserved: rows.reduce((sum, row) => sum + row.reserved, 0),
    breakdown: rows,
    reservations,
  };
}

async function scanEc2(
  config: AwsEnvironmentConfig,
  region: string,
): Promise<InventoryResult> {
  const client = new EC2Client({
    region,
    credentials: config.credentials,
    maxAttempts: 2,
  });
  const breakdown = new Map<string, ResourceBreakdown>();
  const reservationSummaries: ReservationSummary[] = [];
  let nextToken: string | undefined;

  do {
    const response: DescribeInstancesCommandOutput = await client.send(
      new DescribeInstancesCommand({
        Filters: [{ Name: "instance-state-name", Values: ["running"] }],
        NextToken: nextToken,
      }),
    );
    for (const reservation of response.Reservations ?? []) {
      for (const instance of reservation.Instances ?? []) {
        mergeBreakdown(
          breakdown,
          region,
          instance.InstanceType ?? "unknown",
          1,
          0,
        );
      }
    }
    nextToken = response.NextToken;
  } while (nextToken);

  const reservations = await client.send(
    new DescribeReservedInstancesCommand({
      Filters: [{ Name: "state", Values: ["active"] }],
    }),
  );
  for (const reservation of reservations.ReservedInstances ?? []) {
    mergeBreakdown(
      breakdown,
      region,
      reservation.InstanceType ?? "unknown",
      0,
      reservation.InstanceCount ?? 0,
    );
    reservationSummaries.push({
      id: reservation.ReservedInstancesId ?? "unknown",
      kind: "ri",
      service: "Amazon EC2",
      region,
      family: reservation.InstanceType ?? "unknown",
      quantity: reservation.InstanceCount ?? 0,
      start: toIsoString(reservation.Start),
      end: toIsoString(reservation.End),
      utilization: pendingCommitmentUtilization(),
    });
  }
  return resultFromBreakdown(breakdown, reservationSummaries);
}

async function scanRds(
  config: AwsEnvironmentConfig,
  region: string,
): Promise<InventoryResult> {
  const client = new RDSClient({
    region,
    credentials: config.credentials,
    maxAttempts: 2,
  });
  const breakdown = new Map<string, ResourceBreakdown>();
  const reservationSummaries: ReservationSummary[] = [];
  let marker: string | undefined;

  do {
    const response: DescribeDBInstancesCommandOutput = await client.send(
      new DescribeDBInstancesCommand({ Marker: marker }),
    );
    for (const instance of response.DBInstances ?? []) {
      mergeBreakdown(
        breakdown,
        region,
        instance.DBInstanceClass ?? "unknown",
        1,
        0,
      );
    }
    marker = response.Marker;
  } while (marker);

  marker = undefined;
  do {
    const response: DescribeReservedDBInstancesCommandOutput =
      await client.send(
      new DescribeReservedDBInstancesCommand({ Marker: marker }),
    );
    for (const reservation of response.ReservedDBInstances ?? []) {
      if (reservation.State === "active") {
        mergeBreakdown(
          breakdown,
          region,
          reservation.DBInstanceClass ?? "unknown",
          0,
          reservation.DBInstanceCount ?? 0,
        );
        reservationSummaries.push({
          id: reservation.ReservedDBInstanceId ?? "unknown",
          kind: "ri",
          service: "Amazon RDS",
          region,
          family: reservation.DBInstanceClass ?? "unknown",
          quantity: reservation.DBInstanceCount ?? 0,
          start: toIsoString(reservation.StartTime),
          end: endFromDuration(reservation.StartTime, reservation.Duration),
          utilization: pendingCommitmentUtilization(),
        });
      }
    }
    marker = response.Marker;
  } while (marker);

  return resultFromBreakdown(breakdown, reservationSummaries);
}

async function scanElastiCache(
  config: AwsEnvironmentConfig,
  region: string,
): Promise<InventoryResult> {
  const client = new ElastiCacheClient({
    region,
    credentials: config.credentials,
    maxAttempts: 2,
  });
  const breakdown = new Map<string, ResourceBreakdown>();
  const reservationSummaries: ReservationSummary[] = [];
  let marker: string | undefined;

  do {
    const response: DescribeCacheClustersCommandOutput = await client.send(
      new DescribeCacheClustersCommand({ Marker: marker }),
    );
    for (const cluster of response.CacheClusters ?? []) {
      mergeBreakdown(
        breakdown,
        region,
        cluster.CacheNodeType ?? "unknown",
        cluster.NumCacheNodes ?? 0,
        0,
      );
    }
    marker = response.Marker;
  } while (marker);

  marker = undefined;
  do {
    const response: DescribeReservedCacheNodesCommandOutput =
      await client.send(
      new DescribeReservedCacheNodesCommand({ Marker: marker }),
    );
    for (const reservation of response.ReservedCacheNodes ?? []) {
      if (reservation.State === "active") {
        mergeBreakdown(
          breakdown,
          region,
          reservation.CacheNodeType ?? "unknown",
          0,
          reservation.CacheNodeCount ?? 0,
        );
        reservationSummaries.push({
          id: reservation.ReservedCacheNodeId ?? "unknown",
          kind: "ri",
          service: "Amazon ElastiCache",
          region,
          family: reservation.CacheNodeType ?? "unknown",
          quantity: reservation.CacheNodeCount ?? 0,
          start: toIsoString(reservation.StartTime),
          end: endFromDuration(reservation.StartTime, reservation.Duration),
          utilization: pendingCommitmentUtilization(),
        });
      }
    }
    marker = response.Marker;
  } while (marker);

  return resultFromBreakdown(breakdown, reservationSummaries);
}

async function scanRedshift(
  config: AwsEnvironmentConfig,
  region: string,
): Promise<InventoryResult> {
  const client = new RedshiftClient({
    region,
    credentials: config.credentials,
    maxAttempts: 2,
  });
  const breakdown = new Map<string, ResourceBreakdown>();
  const reservationSummaries: ReservationSummary[] = [];
  let marker: string | undefined;

  do {
    const response: DescribeClustersCommandOutput = await client.send(
      new DescribeClustersCommand({ Marker: marker }),
    );
    for (const cluster of response.Clusters ?? []) {
      mergeBreakdown(
        breakdown,
        region,
        cluster.NodeType ?? "unknown",
        cluster.NumberOfNodes ?? 0,
        0,
      );
    }
    marker = response.Marker;
  } while (marker);

  marker = undefined;
  do {
    const response: DescribeReservedNodesCommandOutput = await client.send(
      new DescribeReservedNodesCommand({ Marker: marker }),
    );
    for (const reservation of response.ReservedNodes ?? []) {
      if (reservation.State === "active") {
        mergeBreakdown(
          breakdown,
          region,
          reservation.NodeType ?? "unknown",
          0,
          reservation.NodeCount ?? 0,
        );
        reservationSummaries.push({
          id: reservation.ReservedNodeId ?? "unknown",
          kind: "ri",
          service: "Amazon Redshift",
          region,
          family: reservation.NodeType ?? "unknown",
          quantity: reservation.NodeCount ?? 0,
          start: toIsoString(reservation.StartTime),
          end: endFromDuration(reservation.StartTime, reservation.Duration),
          utilization: pendingCommitmentUtilization(),
        });
      }
    }
    marker = response.Marker;
  } while (marker);

  return resultFromBreakdown(breakdown, reservationSummaries);
}

function chunks<T>(values: T[], size: number) {
  return Array.from(
    { length: Math.ceil(values.length / size) },
    (_, index) => values.slice(index * size, index * size + size),
  );
}

async function scanOpenSearch(
  config: AwsEnvironmentConfig,
  region: string,
): Promise<InventoryResult> {
  const client = new OpenSearchClient({
    region,
    credentials: config.credentials,
    maxAttempts: 2,
  });
  const breakdown = new Map<string, ResourceBreakdown>();
  const reservationSummaries: ReservationSummary[] = [];
  const domains = await client.send(new ListDomainNamesCommand({}));
  const names = (domains.DomainNames ?? [])
    .map((domain) => domain.DomainName)
    .filter((name): name is string => Boolean(name));

  for (const group of chunks(names, 5)) {
    const response = await client.send(
      new DescribeDomainsCommand({ DomainNames: group }),
    );
    for (const domain of response.DomainStatusList ?? []) {
      mergeBreakdown(
        breakdown,
        region,
        domain.ClusterConfig?.InstanceType ?? "unknown",
        domain.ClusterConfig?.InstanceCount ?? 0,
        0,
      );
    }
  }

  let nextToken: string | undefined;
  do {
    const response: DescribeOpenSearchReservedInstancesCommandOutput =
      await client.send(
      new DescribeOpenSearchReservedInstancesCommand({
        NextToken: nextToken,
        MaxResults: 100,
      }),
    );
    for (const reservation of response.ReservedInstances ?? []) {
      if (reservation.State === "active") {
        mergeBreakdown(
          breakdown,
          region,
          reservation.InstanceType ?? "unknown",
          0,
          reservation.InstanceCount ?? 0,
        );
        reservationSummaries.push({
          id: reservation.ReservedInstanceId ?? "unknown",
          kind: "ri",
          service: "Amazon OpenSearch",
          region,
          family: reservation.InstanceType ?? "unknown",
          quantity: reservation.InstanceCount ?? 0,
          start: toIsoString(reservation.StartTime),
          end: endFromDuration(reservation.StartTime, reservation.Duration),
          utilization: pendingCommitmentUtilization(),
        });
      }
    }
    nextToken = response.NextToken;
  } while (nextToken);

  return resultFromBreakdown(breakdown, reservationSummaries);
}

const inventoryScanners: Record<
  ServiceKey,
  (
    config: AwsEnvironmentConfig,
    region: string,
  ) => Promise<InventoryResult>
> = {
  ec2: scanEc2,
  rds: scanRds,
  elasticache: scanElastiCache,
  opensearch: scanOpenSearch,
  redshift: scanRedshift,
};

async function reservationCoverage(
  client: CostExplorerClient,
  serviceName: string,
  window: { start: string; end: string },
) {
  const response = await client.send(
    new GetReservationCoverageCommand({
      TimePeriod: { Start: window.start, End: window.end },
      Filter: {
        Dimensions: { Key: "SERVICE", Values: [serviceName] },
      },
      Metrics: ["Hour"],
    }),
  );

  return toPercentage(
    response.Total?.CoverageHours?.CoverageHoursPercentage ??
      response.CoveragesByTime?.[0]?.Total?.CoverageHours
        ?.CoverageHoursPercentage,
  );
}

async function reservationUtilizationById(
  client: CostExplorerClient,
  serviceName: string,
  window: { start: string; end: string },
) {
  const utilizationById = new Map<string, number | null>();
  let nextPageToken: string | undefined;

  do {
    const response = await client.send(
      new GetReservationUtilizationCommand({
        TimePeriod: { Start: window.start, End: window.end },
        GroupBy: [{ Type: "DIMENSION", Key: "SUBSCRIPTION_ID" }],
        Filter: {
          Dimensions: { Key: "SERVICE", Values: [serviceName] },
        },
        NextPageToken: nextPageToken,
      }),
    );

    for (const period of response.UtilizationsByTime ?? []) {
      for (const group of period.Groups ?? []) {
        const utilization = toPercentage(
          group.Utilization?.UtilizationPercentage,
        );
        const identifiers = [
          group.Key,
          group.Value,
          ...Object.values(group.Attributes ?? {}),
        ].filter((value): value is string => Boolean(value));

        for (const identifier of identifiers) {
          utilizationById.set(identifier, utilization);
        }
      }
    }
    nextPageToken = response.NextPageToken;
  } while (nextPageToken);

  return utilizationById;
}

function reservationUtilizationMetric(
  reservationId: string,
  utilizationById: Map<string, number | null>,
) {
  const direct = utilizationById.get(reservationId);
  if (direct !== undefined) {
    return metricValue(direct);
  }

  const matched = [...utilizationById.entries()].find(
    ([identifier]) =>
      identifier.endsWith(`/${reservationId}`) ||
      identifier.endsWith(`:${reservationId}`) ||
      identifier.includes(reservationId),
  );

  return matched
    ? metricValue(matched[1])
    : {
        value: null,
        status: "unavailable" as const,
        message: "최근 30일에 이 RI의 사용 데이터가 없습니다.",
      };
}

async function savingsPlansCoverage(
  client: CostExplorerClient,
  window: { start: string; end: string },
) {
  const response = await client.send(
    new GetSavingsPlansCoverageCommand({
      TimePeriod: { Start: window.start, End: window.end },
      Granularity: "DAILY",
      Metrics: ["SpendCoveredBySavingsPlans"],
    }),
  );
  const daily = (response.SavingsPlansCoverages ?? [])
    .map((item) => ({
      date: item.TimePeriod?.Start ?? "",
      coveragePercentage: toPercentage(item.Coverage?.CoveragePercentage),
    }))
    .filter((item) => item.date);
  const totals = (response.SavingsPlansCoverages ?? []).reduce(
    (sum, item) => ({
      covered:
        sum.covered +
        asNumber(item.Coverage?.SpendCoveredBySavingsPlans),
      onDemand: sum.onDemand + asNumber(item.Coverage?.OnDemandCost),
      total: sum.total + asNumber(item.Coverage?.TotalCost),
    }),
    { covered: 0, onDemand: 0, total: 0 },
  );

  return {
    coveragePercentage:
      totals.total > 0
        ? Math.round((totals.covered / totals.total) * 1_000) / 10
        : null,
    uncoveredOnDemandUsd:
      response.SavingsPlansCoverages?.length
        ? Math.round(totals.onDemand * 100) / 100
        : null,
    daily,
  };
}

async function savingsPlansCoverageByService(
  client: CostExplorerClient,
  window: { start: string; end: string },
): Promise<SavingsPlansServiceCoverage[]> {
  const servicesByName = new Map<string, SavingsPlansServiceCoverage>();
  let nextToken: string | undefined;

  do {
    const response = await client.send(
      new GetSavingsPlansCoverageCommand({
        TimePeriod: { Start: window.start, End: window.end },
        GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
        Metrics: ["SpendCoveredBySavingsPlans"],
        MaxResults: 100,
        NextToken: nextToken,
      }),
    );

    for (const item of response.SavingsPlansCoverages ?? []) {
      const attributes = item.Attributes ?? {};
      const service =
        attributes.SERVICE ??
        attributes.Service ??
        attributes.service ??
        Object.values(attributes)[0];
      if (!service) {
        continue;
      }

      servicesByName.set(service, {
        service,
        coveragePercentage: toPercentage(
          item.Coverage?.CoveragePercentage,
        ),
        spendCoveredUsd: toCurrency(
          item.Coverage?.SpendCoveredBySavingsPlans,
        ),
        onDemandCostUsd: toCurrency(item.Coverage?.OnDemandCost),
        totalCostUsd: toCurrency(item.Coverage?.TotalCost),
      });
    }
    nextToken = response.NextToken;
  } while (nextToken);

  return [...servicesByName.values()].sort(
    (left, right) =>
      (right.totalCostUsd ?? 0) - (left.totalCostUsd ?? 0) ||
      left.service.localeCompare(right.service),
  );
}

function savingsPlansCoverageBreakdown(
  result: PromiseSettledResult<SavingsPlansServiceCoverage[]>,
): SavingsPlansCoverageBreakdown {
  if (result.status === "fulfilled") {
    return {
      status: "ready",
      message:
        result.value.length === 0
          ? "최근 완료 30일 동안 Savings Plans 할인 대상 사용 비용이 없습니다."
          : null,
      services: result.value,
    };
  }

  const failure = metricFailure(result.reason);
  return {
    status: failure.status,
    message: failure.message,
    services: [],
  };
}

async function reservationMetrics(
  client: CostExplorerClient,
  window: { start: string; end: string },
): Promise<CommitmentMetricSet> {
  const [coverageResult, utilizationResult] = await Promise.allSettled([
    client.send(
      new GetReservationCoverageCommand({
        TimePeriod: { Start: window.start, End: window.end },
        Granularity: "DAILY",
        Metrics: ["Hour"],
      }),
    ),
    client.send(
      new GetReservationUtilizationCommand({
        TimePeriod: { Start: window.start, End: window.end },
        Granularity: "DAILY",
      }),
    ),
  ]);

  const coverage =
    coverageResult.status === "fulfilled"
      ? metricValue(
          toPercentage(
            coverageResult.value.Total?.CoverageHours
              ?.CoverageHoursPercentage ??
              coverageResult.value.CoveragesByTime?.[0]?.Total?.CoverageHours
                ?.CoverageHoursPercentage,
          ),
        )
      : metricFailure(coverageResult.reason);
  const utilization =
    utilizationResult.status === "fulfilled"
      ? metricValue(
          toPercentage(utilizationResult.value.Total?.UtilizationPercentage),
        )
      : metricFailure(utilizationResult.reason);
  const netSavingsUsd =
    utilizationResult.status === "fulfilled"
      ? metricValue(
          toCurrency(
            utilizationResult.value.Total?.NetRISavings ??
              utilizationResult.value.Total?.RealizedSavings,
          ),
        )
      : metricFailure(utilizationResult.reason);
  const unusedCommitmentUsd =
    utilizationResult.status === "fulfilled"
      ? metricValue(
          toCurrency(utilizationResult.value.Total?.RICostForUnusedHours),
        )
      : metricFailure(utilizationResult.reason);
  const uncoveredOnDemandUsd =
    coverageResult.status === "fulfilled"
      ? metricValue(
          toCurrency(coverageResult.value.Total?.CoverageCost?.OnDemandCost),
        )
      : metricFailure(coverageResult.reason);
  const dailyByDate = new Map<string, CommitmentDailyMetric>();

  if (coverageResult.status === "fulfilled") {
    for (const item of coverageResult.value.CoveragesByTime ?? []) {
      const date = item.TimePeriod?.Start;
      if (!date) {
        continue;
      }
      dailyByDate.set(date, {
        date,
        coveragePercentage: toPercentage(
          item.Total?.CoverageHours?.CoverageHoursPercentage,
        ),
        utilizationPercentage: null,
      });
    }
  }
  if (utilizationResult.status === "fulfilled") {
    for (const item of utilizationResult.value.UtilizationsByTime ?? []) {
      const date = item.TimePeriod?.Start;
      if (!date) {
        continue;
      }
      const current = dailyByDate.get(date);
      dailyByDate.set(date, {
        date,
        coveragePercentage: current?.coveragePercentage ?? null,
        utilizationPercentage: toPercentage(
          item.Total?.UtilizationPercentage,
        ),
      });
    }
  }

  return {
    coverage,
    utilization,
    netSavingsUsd,
    unusedCommitmentUsd,
    uncoveredOnDemandUsd,
    daily: [...dailyByDate.values()].sort((a, b) =>
      a.date.localeCompare(b.date),
    ),
  };
}

async function savingsPlansUtilizationByArn(
  client: CostExplorerClient,
  window: { start: string; end: string },
) {
  const utilizationByArn = new Map<string, MetricValue>();
  let nextToken: string | undefined;

  do {
    const response = await client.send(
      new GetSavingsPlansUtilizationDetailsCommand({
        TimePeriod: { Start: window.start, End: window.end },
        MaxResults: 100,
        NextToken: nextToken,
      }),
    );

    for (const detail of response.SavingsPlansUtilizationDetails ?? []) {
      if (!detail.SavingsPlanArn) {
        continue;
      }
      utilizationByArn.set(
        detail.SavingsPlanArn,
        metricValue(
          toPercentage(detail.Utilization?.UtilizationPercentage),
        ),
      );
    }
    nextToken = response.NextToken;
  } while (nextToken);

  return utilizationByArn;
}

async function savingsPlansMetrics(
  client: CostExplorerClient,
  window: { start: string; end: string },
): Promise<CommitmentMetricSet> {
  const [coverageResult, utilizationResult] = await Promise.allSettled([
    savingsPlansCoverage(client, window),
    client.send(
      new GetSavingsPlansUtilizationCommand({
        TimePeriod: { Start: window.start, End: window.end },
      }),
    ),
  ]);

  const coverage =
    coverageResult.status === "fulfilled"
      ? metricValue(coverageResult.value.coveragePercentage)
      : metricFailure(coverageResult.reason);
  const utilization =
    utilizationResult.status === "fulfilled"
      ? metricValue(
          toPercentage(
            utilizationResult.value.Total?.Utilization
              ?.UtilizationPercentage,
          ),
        )
      : metricFailure(utilizationResult.reason);
  const netSavingsUsd =
    utilizationResult.status === "fulfilled"
      ? metricValue(
          toCurrency(utilizationResult.value.Total?.Savings?.NetSavings),
        )
      : metricFailure(utilizationResult.reason);
  const unusedCommitmentUsd =
    utilizationResult.status === "fulfilled"
      ? metricValue(
          toCurrency(
            utilizationResult.value.Total?.Utilization?.UnusedCommitment,
          ),
        )
      : metricFailure(utilizationResult.reason);
  const uncoveredOnDemandUsd =
    coverageResult.status === "fulfilled"
      ? metricValue(coverageResult.value.uncoveredOnDemandUsd)
      : metricFailure(coverageResult.reason);
  const dailyByDate = new Map<string, CommitmentDailyMetric>();

  if (coverageResult.status === "fulfilled") {
    for (const item of coverageResult.value.daily) {
      dailyByDate.set(item.date, {
        date: item.date,
        coveragePercentage: item.coveragePercentage,
        utilizationPercentage: null,
      });
    }
  }
  if (utilizationResult.status === "fulfilled") {
    for (const item of utilizationResult.value
      .SavingsPlansUtilizationsByTime ?? []) {
      const date = item.TimePeriod?.Start;
      if (!date) {
        continue;
      }
      const current = dailyByDate.get(date);
      dailyByDate.set(date, {
        date,
        coveragePercentage: current?.coveragePercentage ?? null,
        utilizationPercentage: toPercentage(
          item.Utilization?.UtilizationPercentage,
        ),
      });
    }
  }

  return {
    coverage,
    utilization,
    netSavingsUsd,
    unusedCommitmentUsd,
    uncoveredOnDemandUsd,
    daily: [...dailyByDate.values()].sort((a, b) =>
      a.date.localeCompare(b.date),
    ),
  };
}

async function listSavingsPlans(config: AwsEnvironmentConfig) {
  const client = new SavingsplansClient({
    region: "us-east-1",
    credentials: config.credentials,
    maxAttempts: 2,
  });
  const plans: SavingsPlanSummary[] = [];
  let nextToken: string | undefined;

  do {
    const response: DescribeSavingsPlansCommandOutput = await client.send(
      new DescribeSavingsPlansCommand({
        states: ["active"],
        nextToken,
        maxResults: 100,
      }),
    );
    for (const plan of response.savingsPlans ?? []) {
      plans.push({
        id: plan.savingsPlanId ?? "unknown",
        arn: plan.savingsPlanArn ?? null,
        kind: "savings-plan",
        type: plan.savingsPlanType ?? "unknown",
        region: plan.region ?? null,
        hourlyCommitment: asNumber(plan.commitment),
        start: plan.start ?? null,
        end: plan.end ?? null,
        utilization: pendingCommitmentUtilization(),
      });
    }
    nextToken = response.nextToken;
  } while (nextToken);

  return plans;
}

function coverageLevel(
  running: number,
  reserved: number,
  riCoverage: number | null,
): CoverageLevel {
  if (running === 0) {
    return "unknown";
  }

  if (riCoverage !== null) {
    if (riCoverage >= 80) {
      return "good";
    }
    if (riCoverage >= 50) {
      return "attention";
    }
    return "risk";
  }

  if (reserved >= running) {
    return "good";
  }
  return reserved > 0 ? "attention" : "risk";
}

function buildFindings(
  coverage: ServiceCoverage[],
  metrics: CommitmentMetrics,
  reservations: ReservationSummary[],
  savingsPlans: SavingsPlanSummary[],
  savingsPlansError: string | null,
) {
  const findings: Finding[] = [];

  const metricGroups = [
    {
      key: "ri",
      name: "RI",
      metrics: metrics.ri,
      activeCount: reservations.reduce(
        (sum, reservation) => sum + reservation.quantity,
        0,
      ),
    },
    {
      key: "savings-plans",
      name: "Savings Plans",
      metrics: metrics.savingsPlans,
      activeCount: savingsPlans.length,
    },
  ];

  for (const group of metricGroups) {
    if (
      group.activeCount > 0 &&
      group.metrics.utilization.status === "ready" &&
      group.metrics.utilization.value !== null &&
      group.metrics.utilization.value < 80
    ) {
      const unusedPercentage =
        Math.round((100 - group.metrics.utilization.value) * 10) / 10;
      const impactUsd =
        group.metrics.unusedCommitmentUsd.status === "ready"
          ? group.metrics.unusedCommitmentUsd.value
          : null;
      findings.push({
        id: `${group.key}-utilization`,
        severity:
          group.metrics.utilization.value < 50 ||
          (impactUsd !== null && impactUsd >= 1_000)
            ? "high"
            : "medium",
        title: `${group.name} 약정 사용률 ${group.metrics.utilization.value}%`,
        detail: `최근 완료 30일 동안 구매한 약정의 ${unusedPercentage}%가 사용량에 적용되지 않았습니다.`,
        service: group.name,
        impactUsd,
        action: "미사용 약정 비용과 최근 사용량 감소 원인을 확인하세요.",
      });
    }

    if (
      group.metrics.coverage.status === "ready" &&
      group.metrics.coverage.value !== null &&
      group.metrics.coverage.value < 80 &&
      group.metrics.uncoveredOnDemandUsd.status === "ready" &&
      group.metrics.uncoveredOnDemandUsd.value !== null &&
      group.metrics.uncoveredOnDemandUsd.value > 0
    ) {
      const impactUsd = group.metrics.uncoveredOnDemandUsd.value;
      findings.push({
        id: `${group.key}-coverage`,
        severity:
          group.metrics.coverage.value < 50 || impactUsd >= 1_000
            ? "high"
            : "medium",
        title: `${group.name} 할인 적용률 ${group.metrics.coverage.value}%`,
        detail: `최근 완료 30일 동안 약정이 적용되지 않은 할인 대상 비용이 있습니다.`,
        service: group.name,
        impactUsd,
        action:
          "Rightsizing 이후에도 유지될 사용량인지 확인하고 추가 약정 구매를 검토하세요.",
      });
    }

    const pendingMessages = [
      group.metrics.coverage,
      group.metrics.utilization,
      group.metrics.netSavingsUsd,
      group.metrics.unusedCommitmentUsd,
      group.metrics.uncoveredOnDemandUsd,
    ]
      .filter((metric) => metric.status === "pending")
      .map((metric) => metric.message)
      .filter((message): message is string => Boolean(message));
    if (group.activeCount > 0 && pendingMessages.length > 0) {
      findings.push({
        id: `${group.key}-pending`,
        severity: "info",
        title: `${group.name} 비용 데이터 집계 대기 중`,
        detail: [...new Set(pendingMessages)].join(" "),
        service: group.name,
        impactUsd: null,
        action: "AWS 집계가 완료된 뒤 다시 확인하세요.",
      });
    }
  }

  const commitments = [
    ...reservations.map((reservation) => ({
      label: `${reservation.service} RI`,
      end: reservation.end,
    })),
    ...savingsPlans.map((plan) => ({
      label: `${plan.type} Savings Plan`,
      end: plan.end,
    })),
  ]
    .filter(
      (commitment): commitment is { label: string; end: string } =>
        commitment.end !== null,
    )
    .map((commitment) => ({
      ...commitment,
      days: Math.ceil(
        (new Date(commitment.end).getTime() - Date.now()) / 86_400_000,
      ),
    }))
    .filter((commitment) => commitment.days >= 0)
    .sort((a, b) => a.days - b.days);

  const expiringIn30Days = commitments.filter(
    (commitment) => commitment.days <= 30,
  );
  const expiringIn60Days = commitments.filter(
    (commitment) => commitment.days > 30 && commitment.days <= 60,
  );
  if (expiringIn30Days.length > 0) {
    const nearest = expiringIn30Days[0];
    findings.push({
      id: "commitment-expiry-30",
      severity: "high",
      title: `30일 이내 만료 약정 ${expiringIn30Days.length}건`,
      detail: `가장 가까운 만료는 ${nearest.label}, ${nearest.end.slice(0, 10)}입니다.`,
      service: "Commitments",
      impactUsd: null,
      action: "최근 사용량을 기준으로 갱신, 축소 또는 종료 여부를 결정하세요.",
    });
  } else if (expiringIn60Days.length > 0) {
    const nearest = expiringIn60Days[0];
    findings.push({
      id: "commitment-expiry-60",
      severity: "medium",
      title: `60일 이내 만료 약정 ${expiringIn60Days.length}건`,
      detail: `가장 가까운 만료는 ${nearest.label}, ${nearest.end.slice(0, 10)}입니다.`,
      service: "Commitments",
      impactUsd: null,
      action: "갱신 검토 일정을 잡고 담당자를 지정하세요.",
    });
  }

  for (const service of coverage) {
    if (service.errors.length > 0) {
      findings.push({
        id: `${service.key}-scan-error`,
        severity: "info",
        title: `${service.name} 일부 데이터를 확인하지 못했습니다`,
        detail: service.errors.join(" "),
        service: service.name,
        impactUsd: null,
        action: "AWS 읽기 권한과 대상 리전을 확인한 뒤 다시 조회하세요.",
      });
    }
  }

  if (savingsPlansError) {
    findings.push({
      id: "savings-plans-scan-error",
      severity: "info",
      title: "Savings Plans 목록을 확인하지 못했습니다",
      detail: savingsPlansError,
      service: "Savings Plans",
      impactUsd: null,
      action: "Savings Plans 조회 권한과 AWS 연결 상태를 확인하세요.",
    });
  }

  if (findings.length === 0) {
    findings.push({
      id: "coverage-healthy",
      severity: "info",
      title: "현재 기준으로 즉시 조치할 약정 항목이 없습니다",
      detail: "최근 완료 30일의 할인 적용률과 약정 사용률, 순절감액, 만료 일정을 계속 확인하세요.",
      service: "전체",
      impactUsd: null,
      action: null,
    });
  }

  const order = { high: 0, medium: 1, info: 2 };
  return findings.sort(
    (a, b) =>
      order[a.severity] - order[b.severity] ||
      (b.impactUsd ?? -1) - (a.impactUsd ?? -1),
  );
}

export async function scanEnvironment(
  config: AwsEnvironmentConfig,
): Promise<EnvironmentReport> {
  const window = coverageWindow();
  const generatedAt = new Date().toISOString();
  const identityClient = new STSClient({
    region: config.regions[0],
    credentials: config.credentials,
    maxAttempts: 2,
  });

  let accountId: string | null = null;
  try {
    const identity = await identityClient.send(new GetCallerIdentityCommand({}));
    accountId = identity.Account ?? null;
  } catch (error) {
    return {
      id: config.id,
      name: config.name,
      accountId,
      regions: config.regions,
      status: "failed",
      generatedAt,
      coverageWindow: window,
      services: [],
      savingsPlansCoverage: {
        status: "unavailable",
        message: "AWS 연결 후 조회됩니다.",
        services: [],
      },
      metrics: emptyCommitmentMetrics(),
      reservations: [],
      savingsPlans: [],
      findings: [],
      error: errorMessage(error),
    };
  }

  const costClient = new CostExplorerClient({
    region: "us-east-1",
    credentials: config.credentials,
    maxAttempts: 2,
  });
  const [
    plansResult,
    savingsPlansUtilizationResult,
    riMetricsResult,
    savingsPlansMetricsResult,
    savingsPlansCoverageResult,
  ] =
    await Promise.allSettled([
      listSavingsPlans(config),
      savingsPlansUtilizationByArn(costClient, window),
      reservationMetrics(costClient, window),
      savingsPlansMetrics(costClient, window),
      savingsPlansCoverageByService(costClient, window),
    ]);
  const savingsPlans =
    plansResult.status === "fulfilled"
      ? plansResult.value.map((plan) => {
          if (savingsPlansUtilizationResult.status === "rejected") {
            return {
              ...plan,
              utilization: metricFailure(
                savingsPlansUtilizationResult.reason,
              ),
            };
          }

          const utilization = plan.arn
            ? savingsPlansUtilizationResult.value.get(plan.arn)
            : null;
          return {
            ...plan,
            utilization: utilization ?? {
              value: null,
              status: "unavailable",
              message: "최근 30일에 이 Savings Plan의 사용 데이터가 없습니다.",
            },
          };
        })
      : [];
  const metrics: CommitmentMetrics = {
    ri:
      riMetricsResult.status === "fulfilled"
        ? riMetricsResult.value
        : failedMetricSet(riMetricsResult.reason),
    savingsPlans:
      savingsPlansMetricsResult.status === "fulfilled"
        ? savingsPlansMetricsResult.value
        : failedMetricSet(savingsPlansMetricsResult.reason),
  };
  const savingsPlansCoverage = savingsPlansCoverageBreakdown(
    savingsPlansCoverageResult,
  );

  const serviceResults = await Promise.all(
    services.map(async (service) => {
      const errors: string[] = [];
      const inventoryResults = await Promise.allSettled(
        config.regions.map((region) =>
          inventoryScanners[service.key](config, region),
        ),
      );
      const inventories = inventoryResults
        .filter(
          (result): result is PromiseFulfilledResult<InventoryResult> =>
            result.status === "fulfilled",
        )
        .map((result) => result.value);

      for (const result of inventoryResults) {
        if (result.status === "rejected") {
          errors.push(errorMessage(result.reason));
        }
      }

      let reservations = inventories.flatMap(
        (inventory) => inventory.reservations,
      );
      let riCoverage: number | null = null;
      if (service.reservationServiceName) {
        const [coverageResult, utilizationResult] = await Promise.allSettled([
          reservationCoverage(
            costClient,
            service.reservationServiceName,
            window,
          ),
          reservations.length > 0
            ? reservationUtilizationById(
                costClient,
                service.reservationServiceName,
                window,
              )
            : Promise.resolve(new Map<string, number | null>()),
        ]);

        if (coverageResult.status === "fulfilled") {
          riCoverage = coverageResult.value;
        } else {
          errors.push(
            `RI 할인 적용률: ${errorMessage(coverageResult.reason)}`,
          );
        }

        if (utilizationResult.status === "fulfilled") {
          reservations = reservations.map((reservation) => ({
            ...reservation,
            utilization: reservationUtilizationMetric(
              reservation.id,
              utilizationResult.value,
            ),
          }));
        } else {
          const failure = metricFailure(utilizationResult.reason);
          reservations = reservations.map((reservation) => ({
            ...reservation,
            utilization: { ...failure },
          }));
          errors.push(
            `RI 약정별 사용률: ${errorMessage(utilizationResult.reason)}`,
          );
        }
      }

      const running = inventories.reduce(
        (sum, inventory) => sum + inventory.running,
        0,
      );
      const reserved = inventories.reduce(
        (sum, inventory) => sum + inventory.reserved,
        0,
      );

      return {
        coverage: {
          key: service.key,
          name: service.name,
          running,
          reserved,
          riCoveragePercentage: riCoverage,
          savingsPlansCoveragePercentage: null,
          coverageLevel: coverageLevel(running, reserved, riCoverage),
          breakdown: inventories
            .flatMap((inventory) => inventory.breakdown)
            .sort(
              (a, b) =>
                a.region.localeCompare(b.region) ||
                a.family.localeCompare(b.family),
            ),
          errors: [...new Set(errors)],
        } satisfies ServiceCoverage,
        reservations,
      };
    }),
  );
  const serviceCoverage = serviceResults.map((result) => result.coverage);
  const reservations = serviceResults
    .flatMap((result) => result.reservations)
    .sort((a, b) => (a.end ?? "").localeCompare(b.end ?? ""));

  const hasErrors = serviceCoverage.some(
    (service) => service.errors.length > 0,
  ) ||
    plansResult.status === "rejected" ||
    savingsPlansUtilizationResult.status === "rejected" ||
    savingsPlansCoverage.status === "error" ||
    [metrics.ri, metrics.savingsPlans].some((metricSet) =>
      [metricSet.coverage, metricSet.utilization, metricSet.netSavingsUsd].some(
        (metric) => metric.status === "error",
      ),
    );
  const savingsPlansError =
    plansResult.status === "rejected"
      ? errorMessage(plansResult.reason)
      : null;

  return {
    id: config.id,
    name: config.name,
    accountId,
    regions: config.regions,
    status: hasErrors ? "partial" : "ready",
    generatedAt,
    coverageWindow: window,
    services: serviceCoverage,
    savingsPlansCoverage,
    metrics,
    reservations,
    savingsPlans,
    findings: buildFindings(
      serviceCoverage,
      metrics,
      reservations,
      savingsPlans,
      savingsPlansError,
    ),
    error: null,
  };
}
