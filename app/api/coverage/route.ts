import {
  getEnvironmentConfig,
  getEnvironmentName,
} from "../../../lib/aws-config";
import { scanEnvironment } from "../../../lib/aws-scanner";
import type {
  ApiError,
  EnvironmentId,
  EnvironmentReport,
} from "../../../lib/cloudboard";

export const dynamic = "force-dynamic";

const cache = new Map<
  EnvironmentId,
  { expiresAt: number; report: EnvironmentReport }
>();
const cacheTtlMs = 5 * 60 * 1000;

function validEnvironment(value: string | null): value is EnvironmentId {
  return value === "dev" || value === "prd";
}

function constantTimeEqual(left: string, right: string) {
  const length = Math.max(left.length, right.length);
  let result = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    result |=
      (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return result === 0;
}

function unauthorized(): Response {
  const body: ApiError = {
    error: "대시보드 접근 토큰을 확인해 주세요.",
    code: "UNAUTHORIZED",
  };
  return Response.json(body, { status: 401 });
}

export async function GET(request: Request) {
  const expectedToken = process.env.CLOUDBOARD_ACCESS_TOKEN?.trim();
  if (
    expectedToken &&
    !constantTimeEqual(
      request.headers.get("x-cloudboard-token") ?? "",
      expectedToken,
    )
  ) {
    return unauthorized();
  }

  const url = new URL(request.url);
  const environmentId = url.searchParams.get("environment");
  if (!validEnvironment(environmentId)) {
    const body: ApiError = {
      error: "조회할 환경을 선택해 주세요.",
      code: "INVALID_ENVIRONMENT",
    };
    return Response.json(body, { status: 400 });
  }

  const forceRefresh = url.searchParams.get("refresh") === "true";
  const cached = cache.get(environmentId);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return Response.json(cached.report, {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const config = getEnvironmentConfig(environmentId);
  if (!config) {
    const now = new Date();
    const end = new Date(now);
    end.setUTCDate(end.getUTCDate() - 1);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 29);
    const report: EnvironmentReport = {
      id: environmentId,
      name: getEnvironmentName(environmentId),
      accountId: null,
      regions: [],
      status: "unconfigured",
      generatedAt: now.toISOString(),
      coverageWindow: {
        start: start.toISOString().slice(0, 10),
        end: end.toISOString().slice(0, 10),
      },
      services: [],
      savingsPlans: [],
      findings: [],
      error: "이 환경의 AWS 읽기 전용 자격 증명이 설정되지 않았습니다.",
    };
    return Response.json(report, {
      headers: { "Cache-Control": "no-store" },
    });
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
  } catch {
    const body: ApiError = {
      error: "AWS 자원 조회를 완료하지 못했습니다.",
      code: "INTERNAL_ERROR",
    };
    return Response.json(body, { status: 500 });
  }
}
