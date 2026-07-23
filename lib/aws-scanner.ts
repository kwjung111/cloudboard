import {
  CostExplorerClient,
  GetReservationCoverageCommand,
  GetSavingsPlansCoverageCommand,
} from "@aws-sdk/client-cost-explorer";
import {
  DescribeInstancesCommand,
  DescribeReservedInstancesCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import {
  DescribeCacheClustersCommand,
  DescribeReservedCacheNodesCommand,
  ElastiCacheClient,
} from "@aws-sdk/client-elasticache";
import {
  DescribeDomainsCommand,
  DescribeReservedInstancesCommand as DescribeOpenSearchReservedInstancesCommand,
  ListDomainNamesCommand,
  OpenSearchClient,
} from "@aws-sdk/client-opensearch";
import {
  DescribeDBInstancesCommand,
  DescribeReservedDBInstancesCommand,
  RDSClient,
} from "@aws-sdk/client-rds";
import {
  DescribeClustersCommand,
  DescribeReservedNodesCommand,
  RedshiftClient,
} from "@aws-sdk/client-redshift";
import {
  DescribeSavingsPlansCommand,
  SavingsplansClient,
} from "@aws-sdk/client-savingsplans";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { AwsEnvironmentConfig } from "./aws-config";
import type {
  CoverageLevel,
  EnvironmentReport,
  Finding,
  ResourceBreakdown,
  SavingsPlanSummary,
  ServiceCoverage,
  ServiceKey,
} from "./cloudboard";

interface InventoryResult {
  running: number;
  reserved: number;
  breakdown: ResourceBreakdown[];
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

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function coverageWindow() {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 29);
  return { start: formatDate(start), end: formatDate(end) };
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

function resultFromBreakdown(breakdown: Map<string, ResourceBreakdown>) {
  const rows = [...breakdown.values()];
  return {
    running: rows.reduce((sum, row) => sum + row.running, 0),
    reserved: rows.reduce((sum, row) => sum + row.reserved, 0),
    breakdown: rows,
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
  let nextToken: string | undefined;

  do {
    const response = await client.send(
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
  }
  return resultFromBreakdown(breakdown);
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
  let marker: string | undefined;

  do {
    const response = await client.send(
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
    const response = await client.send(
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
      }
    }
    marker = response.Marker;
  } while (marker);

  return resultFromBreakdown(breakdown);
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
  let marker: string | undefined;

  do {
    const response = await client.send(
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
    const response = await client.send(
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
      }
    }
    marker = response.Marker;
  } while (marker);

  return resultFromBreakdown(breakdown);
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
  let marker: string | undefined;

  do {
    const response = await client.send(
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
    const response = await client.send(
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
      }
    }
    marker = response.Marker;
  } while (marker);

  return resultFromBreakdown(breakdown);
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
    const response = await client.send(
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
      }
    }
    nextToken = response.NextToken;
  } while (nextToken);

  return resultFromBreakdown(breakdown);
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
      Filter: {
        Dimensions: {
          Key: "SERVICE",
          Values: ["Amazon Elastic Compute Cloud - Compute"],
        },
      },
      Metrics: ["SpendCoveredBySavingsPlans"],
    }),
  );

  return toPercentage(
    response.SavingsPlansCoverages?.[0]?.Coverage?.CoveragePercentage,
  );
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
    const response = await client.send(
      new DescribeSavingsPlansCommand({
        states: ["active"],
        nextToken,
        maxResults: 100,
      }),
    );
    for (const plan of response.savingsPlans ?? []) {
      plans.push({
        id: plan.savingsPlanId ?? "unknown",
        type: plan.savingsPlanType ?? "unknown",
        region: plan.region ?? null,
        hourlyCommitment: asNumber(plan.commitment),
        end: plan.end ?? null,
      });
    }
    nextToken = response.nextToken;
  } while (nextToken);

  return plans;
}

function coverageLevel(
  service: ServiceDefinition,
  running: number,
  reserved: number,
  riCoverage: number | null,
  spCoverage: number | null,
): CoverageLevel {
  if (running === 0) {
    return "unknown";
  }

  const percentages = [riCoverage, service.key === "ec2" ? spCoverage : null]
    .filter((value): value is number => value !== null);
  if (percentages.length > 0) {
    const combined = Math.max(...percentages);
    if (combined >= 80) {
      return "good";
    }
    if (combined >= 50) {
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
  savingsPlans: SavingsPlanSummary[],
) {
  const findings: Finding[] = [];

  for (const service of coverage) {
    if (service.running > 0 && service.coverageLevel === "risk") {
      findings.push({
        id: `${service.key}-coverage-risk`,
        severity: "high",
        title: `${service.name} 커버리지가 낮습니다`,
        detail:
          service.key === "ec2" && savingsPlans.length === 0
            ? `실행 자원 ${service.running}개에 적용할 활성 RI 또는 Savings Plan이 충분하지 않습니다.`
            : `실행 자원 ${service.running}개 대비 예약 용량과 최근 30일 커버리지를 검토해 주세요.`,
        service: service.name,
      });
    } else if (
      service.running > 0 &&
      service.coverageLevel === "attention"
    ) {
      findings.push({
        id: `${service.key}-coverage-attention`,
        severity: "medium",
        title: `${service.name} 추가 최적화가 가능합니다`,
        detail: "온디맨드 사용량과 예약 만료 일정을 확인해 보세요.",
        service: service.name,
      });
    }

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

  if (findings.length === 0) {
    findings.push({
      id: "coverage-healthy",
      severity: "info",
      title: "즉시 확인할 커버리지 위험이 없습니다",
      detail: "예약 만료일과 사용량 변화를 정기적으로 모니터링하세요.",
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
  const plansResult = await Promise.allSettled([
    listSavingsPlans(config),
    savingsPlansCoverage(costClient, window),
  ]);
  const savingsPlans =
    plansResult[0].status === "fulfilled" ? plansResult[0].value : [];
  const ec2SavingsPlansCoverage =
    plansResult[1].status === "fulfilled" ? plansResult[1].value : null;

  const serviceCoverage = await Promise.all(
    services.map(async (service): Promise<ServiceCoverage> => {
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
      const savingsCoverage =
        service.key === "ec2" ? ec2SavingsPlansCoverage : null;

      return {
        key: service.key,
        name: service.name,
        running,
        reserved,
        riCoveragePercentage: riCoverage,
        savingsPlansCoveragePercentage: savingsCoverage,
        coverageLevel: coverageLevel(
          service,
          running,
          reserved,
          riCoverage,
          savingsCoverage,
        ),
        breakdown: inventories
          .flatMap((inventory) => inventory.breakdown)
          .sort(
            (a, b) =>
              a.region.localeCompare(b.region) ||
              a.family.localeCompare(b.family),
          ),
        errors: [...new Set(errors)],
      };
    }),
  );

  const ec2Coverage = serviceCoverage.find(
    (service) => service.key === "ec2",
  );
  if (plansResult[0].status === "rejected") {
    ec2Coverage?.errors.push(
      `Savings Plans: ${errorMessage(plansResult[0].reason)}`,
    );
  }
  if (plansResult[1].status === "rejected") {
    ec2Coverage?.errors.push(
      `SP 커버리지: ${errorMessage(plansResult[1].reason)}`,
    );
  }

  const hasErrors = serviceCoverage.some(
    (service) => service.errors.length > 0,
  );

  return {
    id: config.id,
    name: config.name,
    accountId,
    regions: config.regions,
    status: hasErrors ? "partial" : "ready",
    generatedAt,
    coverageWindow: window,
    services: serviceCoverage,
    savingsPlans,
    findings: buildFindings(serviceCoverage, savingsPlans),
    error: null,
  };
}
