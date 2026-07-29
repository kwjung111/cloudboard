export type EnvironmentId = string;

export interface EnvironmentSummary {
  id: EnvironmentId;
  name: string;
  group: string;
  regions: string[];
  credentialRef: string;
  configured: boolean;
}

export interface EnvironmentsResponse {
  environments: EnvironmentSummary[];
}

export interface EnvironmentInput {
  id: EnvironmentId;
  name: string;
  group: string;
  regions: string[];
  credentialRef: string;
}

export type ServiceKey =
  | "ec2"
  | "rds"
  | "elasticache"
  | "opensearch"
  | "redshift";

export type ScanStatus = "ready" | "partial" | "failed" | "unconfigured";

export type CoverageLevel = "good" | "attention" | "risk" | "unknown";

export type MetricStatus = "ready" | "pending" | "unavailable" | "error";

export interface ResourceBreakdown {
  region: string;
  family: string;
  running: number;
  reserved: number;
}

export interface MetricValue {
  value: number | null;
  status: MetricStatus;
  message: string | null;
}

export interface CommitmentDailyMetric {
  date: string;
  coveragePercentage: number | null;
  utilizationPercentage: number | null;
}

export interface CommitmentMetricSet {
  coverage: MetricValue;
  utilization: MetricValue;
  netSavingsUsd: MetricValue;
  unusedCommitmentUsd: MetricValue;
  uncoveredOnDemandUsd: MetricValue;
  daily: CommitmentDailyMetric[];
}

export interface CommitmentMetrics {
  ri: CommitmentMetricSet;
  savingsPlans: CommitmentMetricSet;
}

export interface ServiceCoverage {
  key: ServiceKey;
  name: string;
  running: number;
  reserved: number;
  riCoveragePercentage: number | null;
  savingsPlansCoveragePercentage: number | null;
  coverageLevel: CoverageLevel;
  breakdown: ResourceBreakdown[];
  errors: string[];
}

export interface SavingsPlansServiceCoverage {
  service: string;
  coveragePercentage: number | null;
  spendCoveredUsd: number | null;
  onDemandCostUsd: number | null;
  totalCostUsd: number | null;
}

export interface SavingsPlansCoverageBreakdown {
  status: MetricStatus;
  message: string | null;
  services: SavingsPlansServiceCoverage[];
}

export interface ReservationSummary {
  id: string;
  kind: "ri";
  service: string;
  region: string;
  family: string;
  quantity: number;
  start: string | null;
  end: string | null;
  utilization: MetricValue;
}

export interface SavingsPlanSummary {
  id: string;
  arn: string | null;
  kind: "savings-plan";
  type: string;
  region: string | null;
  hourlyCommitment: number;
  start: string | null;
  end: string | null;
  utilization: MetricValue;
}

export interface Finding {
  id: string;
  severity: "high" | "medium" | "info";
  title: string;
  detail: string;
  service: string;
  impactUsd: number | null;
  action: string | null;
}

export type CostAnomalyStatus =
  | "normal"
  | "anomaly"
  | "insufficient-data";

export type CostDataStatus = "ready" | "delayed";

export interface DailyServiceCost {
  service: string;
  usageType: string | null;
  costUsd: number;
}

export interface DailyCostPoint {
  date: string;
  costUsd: number;
  estimated: boolean;
  services: DailyServiceCost[];
}

export interface CostDriver {
  service: string;
  usageType: string | null;
  costUsd: number;
  baselineCostUsd: number | null;
  baselineOccurrences: number;
  changeUsd: number | null;
}

export interface CostIncreaseDetail {
  service: string;
  usageType: string | null;
  basisCostUsd: number;
  weekdayMedianCostUsd: number;
  increaseUsd: number;
  increasePercentage: number | null;
  isNew: boolean;
}

export interface CostAnomalyReport {
  environmentId: EnvironmentId;
  environmentName: string;
  generatedAt: string;
  expectedBasisDate: string;
  basisDate: string;
  dataStatus: CostDataStatus;
  freshnessDays: number;
  costIsEstimated: boolean;
  metric: "NetAmortizedCost";
  costDetailsVersion: 0 | 1;
  status: CostAnomalyStatus;
  totalCostUsd: number;
  weekdayMedianUsd: number | null;
  weekdayChangeUsd: number | null;
  weekdayChangePercentage: number | null;
  previousBasisDate: string | null;
  previousBasisCostUsd: number | null;
  previousBasisChangeUsd: number | null;
  previousBasisChangePercentage: number | null;
  baselineDates: string[];
  thresholds: {
    relativePercentage: number;
    absoluteUsd: number;
  };
  topDrivers: CostDriver[];
  costIncreases: CostIncreaseDetail[];
  message: string;
}

export interface CostReportResponse {
  report: CostReportSummary | null;
}

export type CostReportSummary = Omit<CostAnomalyReport, "costIncreases"> & {
  costIncreaseCount: number;
};

export interface CostReportRunResponse {
  generatedAt: string;
  reports: CostReportSummary[];
  errors: Array<{ environmentId: string; message: string }>;
}

export interface AiAuditEvidence {
  id: string;
  source: "inventory" | "cost-explorer" | "cloudtrail" | "aws-config";
  kind:
    | "inventory-overview"
    | "cost-analysis"
    | "cloudtrail-change-event"
    | "cloudtrail-failed-event"
    | "cloudtrail-query-window"
    | "cloudtrail-query-incomplete"
    | "config-capture"
    | "config-query-window"
    | "config-query-incomplete"
    | "config-change-history"
    | "config-no-change-history";
  label: string;
  detail: string;
  observedAt: string | null;
}

export interface AiAuditSummary {
  status: "normal" | "attention" | "critical" | "unavailable";
  headline: string;
  summary: string;
  highlights: string[];
  evidenceIds: string[];
}

export interface AiAuditReport {
  environmentId: EnvironmentId;
  environmentName: string;
  generatedAt: string;
  status: "ready" | "partial" | "failed";
  model: string;
  costBasis: {
    expectedBasisDate: string | null;
    basisDate: string | null;
    dataStatus: CostDataStatus | "unavailable";
    freshnessDays: number | null;
  };
  costChanges: {
    comparison: "same-weekday-median";
    comparisonAvailable: boolean;
    basisDate: string | null;
    reportGeneratedAt: string | null;
    baselineDates: string[];
    totalItems: number;
  };
  cost: AiAuditSummary;
  resourceChanges: AiAuditSummary;
  evidence: AiAuditEvidence[];
  limitations: string[];
  toolCalls: number;
}

export interface AiAuditResponse {
  report: AiAuditReport | null;
  configured: boolean;
}

export interface AiAuditRunResponse {
  generatedAt: string;
  reports: AiAuditReport[];
  errors: Array<{ environmentId: string; message: string }>;
}

export interface CostDetailPageResponse {
  basisDate: string;
  reportGeneratedAt: string;
  comparisonAvailable: boolean;
  cursor: number;
  nextCursor: number | null;
  limit: number;
  total: number;
  items: CostIncreaseDetail[];
}

export interface EnvironmentReport {
  id: EnvironmentId;
  name: string;
  accountId: string | null;
  regions: string[];
  status: ScanStatus;
  generatedAt: string;
  coverageWindow: {
    start: string;
    end: string;
  };
  services: ServiceCoverage[];
  savingsPlansCoverage: SavingsPlansCoverageBreakdown;
  metrics: CommitmentMetrics;
  reservations: ReservationSummary[];
  savingsPlans: SavingsPlanSummary[];
  findings: Finding[];
  error: string | null;
}

export interface ApiError {
  error: string;
  code:
    | "UNAUTHORIZED"
    | "INVALID_REQUEST"
    | "INVALID_ENVIRONMENT"
    | "ENVIRONMENT_EXISTS"
    | "ENVIRONMENT_NOT_FOUND"
    | "REPORT_NOT_FOUND"
    | "CONFIGURATION_ERROR"
    | "INTERNAL_ERROR";
}
