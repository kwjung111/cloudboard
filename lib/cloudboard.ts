export type EnvironmentId = "dev" | "prd";

export type ServiceKey =
  | "ec2"
  | "rds"
  | "elasticache"
  | "opensearch"
  | "redshift";

export type ScanStatus = "ready" | "partial" | "failed" | "unconfigured";

export type CoverageLevel = "good" | "attention" | "risk" | "unknown";

export interface ResourceBreakdown {
  region: string;
  family: string;
  running: number;
  reserved: number;
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

export interface SavingsPlanSummary {
  id: string;
  type: string;
  region: string | null;
  hourlyCommitment: number;
  end: string | null;
}

export interface Finding {
  id: string;
  severity: "high" | "medium" | "info";
  title: string;
  detail: string;
  service: string;
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
  savingsPlans: SavingsPlanSummary[];
  findings: Finding[];
  error: string | null;
}

export interface ApiError {
  error: string;
  code: "UNAUTHORIZED" | "INVALID_ENVIRONMENT" | "INTERNAL_ERROR";
}
