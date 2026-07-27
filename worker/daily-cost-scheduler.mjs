const reportUrl =
  process.env.CLOUDBOARD_DAILY_REPORT_URL?.trim() ||
  "http://cloudboard:3000/api/reports/daily-cost";
const accessToken = process.env.CLOUDBOARD_ACCESS_TOKEN?.trim();
const runOnStart =
  process.env.CLOUDBOARD_DAILY_REPORT_RUN_ON_START?.trim() !== "false";
const koreaOffsetMs = 9 * 60 * 60 * 1_000;

function nextRunDelay(now = new Date()) {
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

async function runReport() {
  const response = await fetch(reportUrl, {
    method: "POST",
    headers: accessToken
      ? { "x-cloudboard-token": accessToken }
      : undefined,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`report endpoint returned ${response.status}: ${body}`);
  }
  console.log(
    JSON.stringify({
      event: "daily-cost-report-complete",
      completedAt: new Date().toISOString(),
      response: JSON.parse(body),
    }),
  );
}

function scheduleNext() {
  const delay = nextRunDelay();
  const nextRunAt = new Date(Date.now() + delay).toISOString();
  console.log(
    JSON.stringify({
      event: "daily-cost-report-scheduled",
      nextRunAt,
      timezone: "Asia/Seoul",
    }),
  );
  setTimeout(async () => {
    try {
      await runReport();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "daily-cost-report-failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      scheduleNext();
    }
  }, delay);
}

if (runOnStart) {
  runReport()
    .catch((error) => {
      console.error(
        JSON.stringify({
          event: "daily-cost-report-initial-run-failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    })
    .finally(scheduleNext);
} else {
  scheduleNext();
}
