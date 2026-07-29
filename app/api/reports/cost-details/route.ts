import { getEnvironmentSummary } from "../../../../lib/aws-config";
import {
  costIncreaseDetailsPage,
} from "../../../../lib/cost-report-store";
import type {
  ApiError,
  CostDetailPageResponse,
} from "../../../../lib/cloudboard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function boundedInteger(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed)
    ? Math.min(maximum, Math.max(minimum, parsed))
    : fallback;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const environmentId = url.searchParams.get("environment");
  if (!environmentId || !getEnvironmentSummary(environmentId)) {
    const body: ApiError = {
      error: "등록되지 않은 환경입니다.",
      code: "INVALID_ENVIRONMENT",
    };
    return Response.json(body, { status: 400 });
  }

  const basisDate = url.searchParams.get("basisDate");
  const reportGeneratedAt = url.searchParams.get("reportGeneratedAt");
  if (
    !basisDate ||
    !/^\d{4}-\d{2}-\d{2}$/.test(basisDate) ||
    !reportGeneratedAt ||
    reportGeneratedAt.length > 64 ||
    Number.isNaN(Date.parse(reportGeneratedAt))
  ) {
    const body: ApiError = {
      error: "비용 상세 보고서 식별자가 올바르지 않습니다.",
      code: "INVALID_REQUEST",
    };
    return Response.json(body, { status: 400 });
  }

  const cursor = boundedInteger(
    url.searchParams.get("cursor"),
    0,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const limit = boundedInteger(url.searchParams.get("limit"), 100, 1, 100);
  const page = costIncreaseDetailsPage(
    environmentId,
    basisDate,
    reportGeneratedAt,
    cursor,
    limit,
  );
  if (!page) {
    const body: ApiError = {
      error: "비용 상세 보고서가 변경되었습니다. 새로고침해 주세요.",
      code: "REPORT_NOT_FOUND",
    };
    return Response.json(body, { status: 409 });
  }
  const body: CostDetailPageResponse = {
    basisDate,
    reportGeneratedAt,
    comparisonAvailable: page.snapshot.comparisonAvailable,
    cursor,
    nextCursor: page.nextCursor,
    limit,
    total: page.snapshot.totalItems,
    items: page.items,
  };
  return Response.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}
