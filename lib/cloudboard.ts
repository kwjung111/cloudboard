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
}

export interface SavingsPlanSummary {
  id: string;
  kind: "savings-plan";
  type: string;
  region: string | null;
  hourlyCommitment: number;
  start: string | null;
  end: string | null;
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
    | "INVALID_ENVIRONMENT"
    | "ENVIRONMENT_EXISTS"
    | "ENVIRONMENT_NOT_FOUND"
    | "CONFIGURATION_ERROR"
    | "INTERNAL_ERROR";
}
