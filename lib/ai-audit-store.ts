import type { AiAuditReport } from "./cloudboard";
import { getCloudboardDatabase } from "./environment-store";

interface AiAuditReportRow {
  report_json: string;
}

function database() {
  return getCloudboardDatabase();
}

export function saveAiAuditReport(report: AiAuditReport) {
  const instance = database();
  instance.transaction(() => {
    instance
      .prepare(`
        INSERT INTO ai_audit_reports
          (environment_id, generated_at, status, model, report_json)
        VALUES
          (@environmentId, @generatedAt, @status, @model, @reportJson)
      `)
      .run({
        environmentId: report.environmentId,
        generatedAt: report.generatedAt,
        status: report.status,
        model: report.model,
        reportJson: JSON.stringify(report),
      });
    instance
      .prepare(`
        DELETE FROM ai_audit_reports
        WHERE environment_id = @environmentId
          AND id NOT IN (
            SELECT id
            FROM ai_audit_reports
            WHERE environment_id = @environmentId
            ORDER BY generated_at DESC, id DESC
            LIMIT 90
          )
      `)
      .run({ environmentId: report.environmentId });
  })();
}

export function latestAiAuditReport(
  environmentId: string,
): AiAuditReport | null {
  const row = database()
    .prepare(`
      SELECT report_json
      FROM ai_audit_reports
      WHERE environment_id = ?
      ORDER BY generated_at DESC, id DESC
      LIMIT 1
    `)
    .get(environmentId) as AiAuditReportRow | undefined;
  return row ? (JSON.parse(row.report_json) as AiAuditReport) : null;
}
