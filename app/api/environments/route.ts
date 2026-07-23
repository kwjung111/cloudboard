import { authorizeRequest } from "../../../lib/api-auth";
import { getEnvironmentSummaries } from "../../../lib/aws-config";
import type {
  ApiError,
  EnvironmentsResponse,
} from "../../../lib/cloudboard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const unauthorized = authorizeRequest(request);
  if (unauthorized) {
    return unauthorized;
  }

  try {
    const body: EnvironmentsResponse = {
      environments: getEnvironmentSummaries(),
    };
    return Response.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error(
      "CloudBoard environment discovery failed",
      error instanceof Error ? { name: error.name, message: error.message } : {},
    );
    const body: ApiError = {
      error: "환경 설정 파일을 확인해 주세요.",
      code: "CONFIGURATION_ERROR",
    };
    return Response.json(body, { status: 500 });
  }
}
