import { authorizeRequest } from "../../../../lib/api-auth";
import {
  getEnvironmentConfig,
  getEnvironmentSummary,
  getEnvironmentSummaries,
} from "../../../../lib/aws-config";
import { generateCostAnomalyReport } from "../../../../lib/cost-anomaly";
import {
  latestCostAnomalyReport,
  saveCostAnomalyReport,
} from "../../../../lib/cost-report-store";
import type {
  ApiError,
  CostReportResponse,
  CostReportRunResponse,
} from "../../../../lib/cloudboard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function invalidEnvironment(): Response {
  const body: ApiError = {
    error: "등록되지 않은 환경입니다.",
    code: "INVALID_ENVIRONMENT",
  };
  return Response.json(body, { status: 400 });
}

export async function GET(request: Request) {
  const unauthorized = authorizeRequest(request);
  if (unauthorized) {
    return unauthorized;
  }

  const environmentId = new URL(request.url).searchParams.get("environment");
  if (!environmentId || !getEnvironmentSummary(environmentId)) {
    return invalidEnvironment();
  }

  const body: CostReportResponse = {
    report: latestCostAnomalyReport(environmentId),
  };
  return Response.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  const unauthorized = authorizeRequest(request);
  if (unauthorized) {
    return unauthorized;
  }

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
      const report = await generateCostAnomalyReport(config);
      if (!report) {
        errors.push({
          environmentId: environment.id,
          message: "AWS에서 집계 완료된 비용 일자를 찾지 못했습니다.",
        });
        continue;
      }
      saveCostAnomalyReport(report);
      reports.push(report);
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
