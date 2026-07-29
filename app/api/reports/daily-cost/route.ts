import {
  getEnvironmentConfig,
  getEnvironmentSummary,
  getEnvironmentSummaries,
} from "../../../../lib/aws-config";
import type { AwsEnvironmentConfig } from "../../../../lib/aws-config";
import {
  costBasisDate,
  costReportMinimumIntervalMs,
  generateCostAnomalyReport,
} from "../../../../lib/cost-anomaly";
import {
  getCostDetailSnapshot,
  latestCostAnomalyReport,
  saveCostAnomalyReport,
} from "../../../../lib/cost-report-store";
import type {
  ApiError,
  CostAnomalyReport,
  CostReportResponse,
  CostReportRunResponse,
  CostReportSummary,
} from "../../../../lib/cloudboard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const activeRuns = new Map<string, Promise<CostAnomalyReport | null>>();

function detailSnapshot(report: CostAnomalyReport) {
  return report.costDetailsVersion === 1
    ? getCostDetailSnapshot(
        report.environmentId,
        report.basisDate,
        report.generatedAt,
      )
    : null;
}

function summarizeReport(report: CostAnomalyReport): CostReportSummary {
  const snapshot = detailSnapshot(report);
  const { costIncreases, ...summary } = report;
  void costIncreases;
  return {
    ...summary,
    costDetailsVersion: snapshot ? report.costDetailsVersion : 0,
    costIncreaseCount: snapshot?.totalItems ?? 0,
  };
}

async function generateReport(
  config: AwsEnvironmentConfig,
  now: Date,
): Promise<CostAnomalyReport | null> {
  const recent = latestCostAnomalyReport(config.id, now);
  if (
    recent?.expectedBasisDate === costBasisDate(now) &&
    detailSnapshot(recent) &&
    now.getTime() - Date.parse(recent.generatedAt) <
      costReportMinimumIntervalMs()
  ) {
    return recent;
  }

  const runKey = `${config.id}:${costBasisDate(now)}`;
  const active = activeRuns.get(runKey);
  if (active) return active;

  const run = generateCostAnomalyReport(config, now).then((report) => {
    if (!report) return null;
    const updatedLatestReport = saveCostAnomalyReport(report);
    return updatedLatestReport
      ? report
      : latestCostAnomalyReport(config.id, now) ?? report;
  });
  activeRuns.set(runKey, run);
  try {
    return await run;
  } finally {
    if (activeRuns.get(runKey) === run) activeRuns.delete(runKey);
  }
}

function invalidEnvironment(): Response {
  const body: ApiError = {
    error: "등록되지 않은 환경입니다.",
    code: "INVALID_ENVIRONMENT",
  };
  return Response.json(body, { status: 400 });
}

export async function GET(request: Request) {
  const environmentId = new URL(request.url).searchParams.get("environment");
  if (!environmentId || !getEnvironmentSummary(environmentId)) {
    return invalidEnvironment();
  }

  const report = latestCostAnomalyReport(environmentId);
  const body: CostReportResponse = {
    report: report ? summarizeReport(report) : null,
  };
  return Response.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  const environmentId = new URL(request.url).searchParams.get("environment");
  if (environmentId && !getEnvironmentSummary(environmentId)) {
    return invalidEnvironment();
  }

  const environments = environmentId
    ? [getEnvironmentSummary(environmentId)].filter(
        (environment): environment is NonNullable<typeof environment> =>
          Boolean(environment),
      )
    : getEnvironmentSummaries();
  const reports: CostReportRunResponse["reports"] = [];
  const errors: CostReportRunResponse["errors"] = [];
  const now = new Date();

  for (const environment of environments) {
    const config = getEnvironmentConfig(environment.id);
    if (!config) {
      errors.push({
        environmentId: environment.id,
        message: "AWS 읽기 전용 자격 증명이 설정되지 않았습니다.",
      });
      continue;
    }

    try {
      const report = await generateReport(config, now);
      if (!report) {
        errors.push({
          environmentId: environment.id,
          message: "AWS에서 집계 완료된 비용 일자를 찾지 못했습니다.",
        });
        continue;
      }
      reports.push(summarizeReport(report));
    } catch (error) {
      console.error(
        "Daily cost report generation failed",
        error instanceof Error
          ? { environmentId: environment.id, name: error.name }
          : { environmentId: environment.id },
      );
      errors.push({
        environmentId: environment.id,
        message: "AWS 비용 데이터를 조회하지 못했습니다.",
      });
    }
  }

  const body: CostReportRunResponse = {
    generatedAt: new Date().toISOString(),
    reports,
    errors,
  };
  return Response.json(body, {
    status: reports.length === 0 && errors.length > 0 ? 502 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
