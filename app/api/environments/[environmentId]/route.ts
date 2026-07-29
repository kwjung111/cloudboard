import {
  deleteEnvironment,
  EnvironmentNotFoundError,
  InvalidEnvironmentError,
} from "../../../../lib/environment-store";
import type { ApiError } from "../../../../lib/cloudboard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ environmentId: string }> },
) {
  const { environmentId } = await context.params;
  try {
    deleteEnvironment(environmentId);
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof InvalidEnvironmentError) {
      const body: ApiError = {
        error: error.message,
        code: "INVALID_ENVIRONMENT",
      };
      return Response.json(body, { status: 400 });
    }
    if (error instanceof EnvironmentNotFoundError) {
      const body: ApiError = {
        error: error.message,
        code: "ENVIRONMENT_NOT_FOUND",
      };
      return Response.json(body, { status: 404 });
    }

    console.error(
      "CloudBoard environment deletion failed",
      error instanceof Error ? { name: error.name, message: error.message } : {},
    );
    const body: ApiError = {
      error: "환경을 삭제하지 못했습니다.",
      code: "INTERNAL_ERROR",
    };
    return Response.json(body, { status: 500 });
  }
}
