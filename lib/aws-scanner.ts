import {
  CostExplorerClient,
  GetReservationCoverageCommand,
  GetReservationUtilizationCommand,
  GetSavingsPlansCoverageCommand,
  GetSavingsPlansUtilizationCommand,
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
  CommitmentMetricSet,
  CommitmentMetrics,
  CoverageLevel,
  EnvironmentReport,
  Finding,
  MetricValue,
  ReservationSummary,
  ResourceBreakdown,
  SavingsPlanSummary,
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
    reservationServiceName: null,
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
  };
}

function failedMetricSet(error: unknown): CommitmentMetricSet {
  const failure = metricFailure(error);
  return {
    coverage: failure,
    utilization: { ...failure },
    netSavingsUsd: { ...failure },
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

async function savingsPlansCoverage(
  client: CostExplorerClient,
  window: { start: string; end: string },
) {
  const response = await client.send(
    new GetSavingsPlansCoverageCommand({
      TimePeriod: { Start: window.start, End: window.end },
      Metrics: ["SpendCoveredBySavingsPlans"],
    }),
  );

  return toPercentage(
    response.SavingsPlansCoverages?.[0]?.Coverage?.CoveragePercentage,
  );
}

async function reservationMetrics(
  client: CostExplorerClient,
  window: { start: string; end: string },
): Promise<CommitmentMetricSet> {
  const [coverageResult, utilizationResult] = await Promise.allSettled([
    client.send(
      new GetReservationCoverageCommand({
        TimePeriod: { Start: window.start, End: window.end },
        Metrics: ["Hour"],
      }),
    ),
    client.send(
      new GetReservationUtilizationCommand({
        TimePeriod: { Start: window.start, End: window.end },
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

  if (utilizationResult.status === "rejected") {
    const failure = metricFailure(utilizationResult.reason);
    return {
      coverage,
      utilization: failure,
      netSavingsUsd: { ...failure },
    };
  }

  return {
    coverage,
    utilization: metricValue(
      toPercentage(utilizationResult.value.Total?.UtilizationPercentage),
    ),
    netSavingsUsd: metricValue(
      toCurrency(
        utilizationResult.value.Total?.NetRISavings ??
          utilizationResult.value.Total?.RealizedSavings,
      ),
    ),
  };
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
      ? metricValue(coverageResult.value)
      : metricFailure(coverageResult.reason);

  if (utilizationResult.status === "rejected") {
    const failure = metricFailure(utilizationResult.reason);
    return {
      coverage,
      utilization: failure,
      netSavingsUsd: { ...failure },
    };
  }

  return {
    coverage,
    utilization: metricValue(
      toPercentage(
        utilizationResult.value.Total?.Utilization?.UtilizationPercentage,
      ),
    ),
    netSavingsUsd: metricValue(
      toCurrency(utilizationResult.value.Total?.Savings?.NetSavings),
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
        kind: "savings-plan",
        type: plan.savingsPlanType ?? "unknown",
        region: plan.region ?? null,
        hourlyCommitment: asNumber(plan.commitment),
        start: plan.start ?? null,
        end: plan.end ?? null,
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
      findings.push({
        id: `${group.key}-utilization`,
        severity:
          group.metrics.utilization.value < 50 ? "high" : "medium",
        title: `${group.name} 사용률을 점검해 주세요`,
        detail: `최근 30일 사용률이 ${group.metrics.utilization.value}%입니다. 미사용 약정 비용을 확인하세요.`,
        service: group.name,
      });
    }

    const pendingMessages = [
      group.metrics.coverage,
      group.metrics.utilization,
      group.metrics.netSavingsUsd,
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
    });
  } else if (expiringIn60Days.length > 0) {
    const nearest = expiringIn60Days[0];
    findings.push({
      id: "commitment-expiry-60",
      severity: "medium",
      title: `60일 이내 만료 약정 ${expiringIn60Days.length}건`,
      detail: `가장 가까운 만료는 ${nearest.label}, ${nearest.end.slice(0, 10)}입니다.`,
      service: "Commitments",
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
    });
  }

  if (findings.length === 0) {
    findings.push({
      id: "coverage-healthy",
      severity: "info",
      title: "즉시 확인할 약정 위험이 없습니다",
      detail: "커버리지, 사용률, 절감액과 만료 일정을 정기적으로 확인하세요.",
      service: "전체",
    });
  }

  const order = { high: 0, medium: 1, info: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
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
  const [plansResult, riMetricsResult, savingsPlansMetricsResult] =
    await Promise.allSettled([
      listSavingsPlans(config),
      reservationMetrics(costClient, window),
      savingsPlansMetrics(costClient, window),
    ]);
  const savingsPlans =
    plansResult.status === "fulfilled" ? plansResult.value : [];
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

      let riCoverage: number | null = null;
      if (service.reservationServiceName) {
        try {
          riCoverage = await reservationCoverage(
            costClient,
            service.reservationServiceName,
            window,
          );
        } catch (error) {
          errors.push(`RI 커버리지: ${errorMessage(error)}`);
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
        reservations: inventories.flatMap(
          (inventory) => inventory.reservations,
        ),
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
