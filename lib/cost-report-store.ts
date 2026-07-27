import type { CostAnomalyReport } from "./cloudboard";
import { getCloudboardDatabase } from "./environment-store";

interface CostReportRow {
  report_json: string;
}

function database() {
  const instance = getCloudboardDatabase();
  instance.exec(`
    CREATE TABLE IF NOT EXISTS cost_anomaly_reports (
      environment_id TEXT NOT NULL,
      basis_date TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      report_json TEXT NOT NULL,
      PRIMARY KEY (environment_id, basis_date),
      FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_cost_anomaly_reports_latest
      ON cost_anomaly_reports (environment_id, basis_date DESC);

    INSERT OR IGNORE INTO schema_migrations (version) VALUES (2);
  `);
  return instance;
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
