import { authorizeRequest } from "../../../lib/api-auth";
import {
  getEnvironmentSummaries,
  getEnvironmentSummary,
} from "../../../lib/aws-config";
import {
  createEnvironment,
  EnvironmentAlreadyExistsError,
  InvalidEnvironmentError,
} from "../../../lib/environment-store";
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
      error: "환경 저장소를 확인해 주세요.",
      code: "CONFIGURATION_ERROR",
    };
    return Response.json(body, { status: 500 });
  }
}

export async function POST(request: Request) {
  const unauthorized = authorizeRequest(request);
  if (unauthorized) {
    return unauthorized;
  }

  try {
    const input = (await request.json()) as unknown;
    const created = createEnvironment(input);
    const environment = getEnvironmentSummary(created.id);
    return Response.json(environment, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (
      error instanceof InvalidEnvironmentError ||
      error instanceof SyntaxError
    ) {
      const body: ApiError = {
        error:
          error instanceof InvalidEnvironmentError
            ? error.message
            : "환경 설정 형식이 올바르지 않습니다.",
        code: "INVALID_ENVIRONMENT",
      };
      return Response.json(body, { status: 400 });
    }
    if (error instanceof EnvironmentAlreadyExistsError) {
      const body: ApiError = {
        error: error.message,
        code: "ENVIRONMENT_EXISTS",
      };
      return Response.json(body, { status: 409 });
    }

    console.error(
      "CloudBoard environment creation failed",
      error instanceof Error ? { name: error.name, message: error.message } : {},
    );
    const body: ApiError = {
      error: "환경을 저장하지 못했습니다.",
      code: "INTERNAL_ERROR",
    };
    return Response.json(body, { status: 500 });
  }
}
