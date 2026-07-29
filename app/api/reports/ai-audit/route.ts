import { authorizeRequest } from "../../../../lib/api-auth";
import {
  AiAuditNotConfiguredError,
  aiAuditConfigured,
  runAiAudit,
} from "../../../../lib/ai-audit-agent";
import {
  getEnvironmentConfig,
  getEnvironmentSummary,
  getEnvironmentSummaries,
} from "../../../../lib/aws-config";
import {
  latestAiAuditReport,
  saveAiAuditReport,
} from "../../../../lib/ai-audit-store";
import type {
  AiAuditReport,
  AiAuditResponse,
  AiAuditRunResponse,
  ApiError,
} from "../../../../lib/cloudboard";
import type { AwsEnvironmentConfig } from "../../../../lib/aws-config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const activeRuns = new Map<string, Promise<AiAuditReport>>();

function requireAiAuditAuthorization(request: Request): Response | null {
  if (!process.env.CLOUDBOARD_ACCESS_TOKEN?.trim()) {
    const body: ApiError = {
      error: "AI 요약 API를 사용하려면 서버에 CLOUDBOARD_ACCESS_TOKEN을 설정해 주세요.",
      code: "CONFIGURATION_ERROR",
    };
    return Response.json(body, { status: 503 });
  }
  return authorizeRequest(request);
}

function minimumRunIntervalMs() {
  const seconds = Number(
    process.env.CLOUDBOARD_AI_AUDIT_MIN_INTERVAL_SECONDS?.trim() || "300",
  );
  const bounded = Number.isFinite(seconds)
    ? Math.min(86_400, Math.max(60, Math.floor(seconds)))
    : 300;
  return bounded * 1_000;
}

async function generateReport(config: AwsEnvironmentConfig) {
  const recent = latestAiAuditReport(config.id);
  if (
    recent &&
    Date.now() - Date.parse(recent.generatedAt) < minimumRunIntervalMs()
  ) {
    return recent;
  }

  const active = activeRuns.get(config.id);
  if (active) return active;

  const run = runAiAudit(config).then((report) => {
    saveAiAuditReport(report);
    return report;
  });
  activeRuns.set(config.id, run);
  try {
    return await run;
  } finally {
    if (activeRuns.get(config.id) === run) activeRuns.delete(config.id);
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
  const unauthorized = requireAiAuditAuthorization(request);
  if (unauthorized) {
    return unauthorized;
  }

  const environmentId = new URL(request.url).searchParams.get("environment");
  if (!environmentId || !getEnvironmentSummary(environmentId)) {
    return invalidEnvironment();
  }

  const body: AiAuditResponse = {
    report: latestAiAuditReport(environmentId),
    configured: aiAuditConfigured(),
  };
  return Response.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  const unauthorized = requireAiAuditAuthorization(request);
  if (unauthorized) {
    return unauthorized;
  }

  if (!aiAuditConfigured()) {
    const body: ApiError = {
      error: "AI 요약을 사용하려면 서버에 OPENAI_API_KEY를 설정해 주세요.",
      code: "CONFIGURATION_ERROR",
    };
    return Response.json(body, { status: 503 });
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
  const reports: AiAuditRunResponse["reports"] = [];
  const errors: AiAuditRunResponse["errors"] = [];

  await Promise.all(environments.map(async (environment) => {
    const config = getEnvironmentConfig(environment.id);
    if (!config) {
      errors.push({
        environmentId: environment.id,
        message: "AWS 읽기 전용 자격 증명이 설정되지 않았습니다.",
      });
      return;
    }

    try {
      const report = await generateReport(config);
      reports.push(report);
    } catch (error) {
      console.error(
        "AI AWS summary generation failed",
        error instanceof Error
          ? { environmentId: environment.id, name: error.name }
          : { environmentId: environment.id },
      );
      errors.push({
        environmentId: environment.id,
        message:
          error instanceof AiAuditNotConfiguredError
            ? error.message
            : "AI 요약을 완료하지 못했습니다. AWS 권한과 OpenAI 연결을 확인해 주세요.",
      });
    }
  }));

  const body: AiAuditRunResponse = {
    generatedAt: new Date().toISOString(),
    reports,
    errors,
  };
  return Response.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}
