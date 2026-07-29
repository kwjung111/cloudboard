import { pathToFileURL } from "node:url";

const dailyReportUrl =
  process.env.CLOUDBOARD_DAILY_REPORT_URL?.trim() ||
  "http://cloudboard:3000/api/reports/daily-cost";
const aiAuditUrl =
  process.env.CLOUDBOARD_AI_AUDIT_URL?.trim() ||
  "http://cloudboard:3000/api/reports/ai-audit";
const aiAuditEnabled =
  process.env.CLOUDBOARD_AI_AUDIT_ENABLED?.trim() === "true";
const configuredTimeoutMs = Number(
  process.env.CLOUDBOARD_REPORT_TIMEOUT_MS?.trim() || "330000",
);
const reportTimeoutMs = Number.isFinite(configuredTimeoutMs)
  ? Math.min(600_000, Math.max(10_000, Math.floor(configuredTimeoutMs)))
  : 330_000;
const runOnStart =
  process.env.CLOUDBOARD_DAILY_REPORT_RUN_ON_START?.trim() !== "false";
const koreaOffsetMs = 9 * 60 * 60 * 1_000;

export function nextRunDelay(now = new Date()) {
  const koreaNow = new Date(now.getTime() + koreaOffsetMs);
  let target = Date.UTC(
    koreaNow.getUTCFullYear(),
    koreaNow.getUTCMonth(),
    koreaNow.getUTCDate(),
    6,
  ) - koreaOffsetMs;
  if (target <= now.getTime()) {
    target += 24 * 60 * 60 * 1_000;
  }
  return target - now.getTime();
}

export async function runReport(
  name,
  url,
  fetcher = fetch,
  timeoutMs = reportTimeoutMs,
) {
  const response = await fetcher(url, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${name} endpoint returned ${response.status}`);
  }
  const result = JSON.parse(body);
  const errors = Array.isArray(result.errors) ? result.errors.length : 0;
  console.log(
    JSON.stringify({
      event: `${name}-complete`,
      completedAt: new Date().toISOString(),
      reports: Array.isArray(result.reports) ? result.reports.length : 0,
      errors,
    }),
  );
  if (errors > 0) {
    throw new Error(`${name} reported ${errors} environment error(s)`);
  }
}

async function runReports() {
  const reports = [
    { name: "daily-cost-report", url: dailyReportUrl },
    ...(aiAuditEnabled
      ? [{ name: "ai-audit-report", url: aiAuditUrl }]
      : []),
  ];
  const results = await Promise.allSettled(
    reports.map((report) => runReport(report.name, report.url)),
  );
  const failures = results
    .filter((result) => result.status === "rejected")
    .map((result) =>
      result.reason instanceof Error ? result.reason.message : String(result.reason),
    );
  if (failures.length > 0) {
    throw new Error(failures.join(" / "));
  }
}

function scheduleNext() {
  const delay = nextRunDelay();
  const nextRunAt = new Date(Date.now() + delay).toISOString();
  console.log(
    JSON.stringify({
      event: "cloudboard-reports-scheduled",
      nextRunAt,
      timezone: "Asia/Seoul",
    }),
  );
  setTimeout(async () => {
    try {
      await runReports();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "cloudboard-reports-failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      scheduleNext();
    }
  }, delay);
}

const isMain = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href,
);

if (isMain) {
  if (runOnStart) {
    runReports()
      .catch((error) => {
        console.error(
          JSON.stringify({
            event: "cloudboard-reports-initial-run-failed",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      })
      .finally(scheduleNext);
  } else {
    scheduleNext();
  }
}
