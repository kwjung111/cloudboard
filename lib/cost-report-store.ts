import type { CostAnomalyReport } from "./cloudboard";
import { costBasisDate, costFreshnessDays } from "./cost-anomaly";
import { getCloudboardDatabase } from "./environment-store";

interface CostReportRow {
  report_json: string;
}

function database() {
  return getCloudboardDatabase();
}

export function saveCostAnomalyReport(report: CostAnomalyReport) {
  database()
    .prepare(`
      INSERT INTO cost_anomaly_reports
        (environment_id, basis_date, generated_at, status, report_json)
      VALUES
        (@environmentId, @basisDate, @generatedAt, @status, @reportJson)
      ON CONFLICT(environment_id, basis_date) DO UPDATE SET
        generated_at = excluded.generated_at,
        status = excluded.status,
        report_json = excluded.report_json
    `)
    .run({
      environmentId: report.environmentId,
      basisDate: report.basisDate,
      generatedAt: report.generatedAt,
      status: report.status,
      reportJson: JSON.stringify(report),
    });
}

export function latestCostAnomalyReport(
  environmentId: string,
  now = new Date(),
): CostAnomalyReport | null {
  const expectedBasisDate = costBasisDate(now);
  const row = database()
    .prepare(`
      SELECT report_json
      FROM cost_anomaly_reports
      WHERE environment_id = ? AND basis_date <= ?
      ORDER BY generated_at DESC
      LIMIT 1
    `)
    .get(environmentId, expectedBasisDate) as CostReportRow | undefined;
  if (!row) return null;

  const stored = JSON.parse(row.report_json) as CostAnomalyReport & {
    previousFinalizedDate?: string | null;
    previousFinalizedCostUsd?: number | null;
    previousDayChangeUsd?: number | null;
    previousDayChangePercentage?: number | null;
  };
  const {
    previousFinalizedDate,
    previousFinalizedCostUsd,
    previousDayChangeUsd,
    previousDayChangePercentage,
    ...current
  } = stored;
  return {
    ...current,
    expectedBasisDate: stored.expectedBasisDate ?? expectedBasisDate,
    dataStatus:
      stored.dataStatus ??
      (stored.basisDate === expectedBasisDate ? "ready" : "delayed"),
    freshnessDays: costFreshnessDays(stored.basisDate, now),
    previousBasisDate:
      stored.previousBasisDate ?? previousFinalizedDate ?? null,
    previousBasisCostUsd:
      stored.previousBasisCostUsd ?? previousFinalizedCostUsd ?? null,
    previousBasisChangeUsd:
      stored.previousBasisChangeUsd ?? previousDayChangeUsd ?? null,
    previousBasisChangePercentage:
      stored.previousBasisChangePercentage ??
      previousDayChangePercentage ??
      null,
  };
}
