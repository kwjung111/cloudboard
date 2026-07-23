import type { ApiError } from "./cloudboard";

function constantTimeEqual(left: string, right: string) {
  const length = Math.max(left.length, right.length);
  let result = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    result |=
      (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return result === 0;
}

export function authorizeRequest(request: Request): Response | null {
  const expectedToken = process.env.CLOUDBOARD_ACCESS_TOKEN?.trim();
  if (
    !expectedToken ||
    constantTimeEqual(
      request.headers.get("x-cloudboard-token") ?? "",
      expectedToken,
    )
  ) {
    return null;
  }

  const body: ApiError = {
    error: "대시보드 접근 토큰을 확인해 주세요.",
    code: "UNAUTHORIZED",
  };
  return Response.json(body, { status: 401 });
}
