import type { CostAnomalyReport } from "./cloudboard";
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
): CostAnomalyReport | null {
  const row = database()
    .prepare(`
      SELECT report_json
      FROM cost_anomaly_reports
      WHERE environment_id = ?
      ORDER BY basis_date DESC
      LIMIT 1
    `)
    .get(environmentId) as CostReportRow | undefined;
  return row ? (JSON.parse(row.report_json) as CostAnomalyReport) : null;
}
