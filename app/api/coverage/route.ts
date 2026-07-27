import { authorizeRequest } from "../../../lib/api-auth";
import {
  getEnvironmentConfig,
  getEnvironmentSummary,
} from "../../../lib/aws-config";
import { scanEnvironment } from "../../../lib/aws-scanner";
import type {
  ApiError,
  EnvironmentId,
  EnvironmentReport,
  EnvironmentSummary,
} from "../../../lib/cloudboard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const cache = new Map<
  EnvironmentId,
  { expiresAt: number; report: EnvironmentReport }
>();
const cacheTtlMs = 5 * 60 * 1000;

function unavailableReport(
  environment: EnvironmentSummary,
  error: string,
): EnvironmentReport {
  const now = new Date();
  const end = new Date(now);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 30);

  return {
    id: environment.id,
    name: environment.name,
    accountId: null,
    regions: environment.regions,
    status: "unconfigured",
    generatedAt: now.toISOString(),
    coverageWindow: {
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    },
    services: [],
    savingsPlansCoverage: {
      status: "unavailable",
      message: "AWS 연결 후 조회됩니다.",
      services: [],
    },
    metrics: {
      ri: {
        coverage: { value: null, status: "unavailable", message: null },
        utilization: { value: null, status: "unavailable", message: null },
        netSavingsUsd: { value: null, status: "unavailable", message: null },
        unusedCommitmentUsd: {
          value: null,
          status: "unavailable",
          message: null,
        },
        uncoveredOnDemandUsd: {
          value: null,
          status: "unavailable",
          message: null,
        },
        daily: [],
      },
      savingsPlans: {
        coverage: { value: null, status: "unavailable", message: null },
        utilization: { value: null, status: "unavailable", message: null },
        netSavingsUsd: { value: null, status: "unavailable", message: null },
        unusedCommitmentUsd: {
          value: null,
          status: "unavailable",
          message: null,
        },
        uncoveredOnDemandUsd: {
          value: null,
          status: "unavailable",
          message: null,
        },
        daily: [],
      },
    },
    reservations: [],
    savingsPlans: [],
    findings: [],
    error,
  };
}

function configurationError(): Response {
  const body: ApiError = {
    error: "환경 저장소를 확인해 주세요.",
    code: "CONFIGURATION_ERROR",
  };
  return Response.json(body, { status: 500 });
}

export async function GET(request: Request) {
  const unauthorized = authorizeRequest(request);
  if (unauthorized) {
    return unauthorized;
  }

  const url = new URL(request.url);
  const environmentId = url.searchParams.get("environment");
  if (!environmentId) {
    const body: ApiError = {
      error: "조회할 환경을 선택해 주세요.",
      code: "INVALID_ENVIRONMENT",
    };
    return Response.json(body, { status: 400 });
  }

  let environment: EnvironmentSummary | null;
  try {
    environment = getEnvironmentSummary(environmentId);
  } catch (error) {
    console.error(
      "CloudBoard environment lookup failed",
      error instanceof Error ? { name: error.name, message: error.message } : {},
    );
    return configurationError();
  }

  if (!environment) {
    const body: ApiError = {
      error: "등록되지 않은 환경입니다.",
      code: "INVALID_ENVIRONMENT",
    };
    return Response.json(body, { status: 400 });
  }

  const forceRefresh = url.searchParams.get("refresh") === "true";
  const cached = cache.get(environmentId);
  if (
    !forceRefresh &&
    cached &&
    cached.expiresAt > Date.now() &&
    cached.report.name === environment.name &&
    cached.report.regions.join(",") === environment.regions.join(",")
  ) {
    return Response.json(cached.report, {
      headers: { "Cache-Control": "no-store" },
    });
  }

  let config;
  try {
    config = getEnvironmentConfig(environmentId);
  } catch (error) {
    console.error(
      "CloudBoard credentials configuration failed",
      error instanceof Error ? { name: error.name, message: error.message } : {},
    );
    return Response.json(
      unavailableReport(
        environment,
        "이 환경의 AWS 자격 증명 파일 형식을 확인해 주세요.",
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!config) {
    return Response.json(
      unavailableReport(
        environment,
        "이 환경의 AWS 읽기 전용 자격 증명이 설정되지 않았습니다.",
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const report = await scanEnvironment(config);
    cache.set(environmentId, {
      report,
      expiresAt: Date.now() + cacheTtlMs,
    });
    return Response.json(report, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error(
      "CloudBoard scan failed",
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { name: "UnknownError" },
    );
    const body: ApiError = {
      error: "AWS 자원 조회를 완료하지 못했습니다.",
      code: "INTERNAL_ERROR",
    };
    return Response.json(body, { status: 500 });
  }
}
