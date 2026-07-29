import type {
  CostAnomalyReport,
  CostIncreaseDetail,
} from "./cloudboard";
import { costBasisDate, costFreshnessDays } from "./cost-anomaly";
import { getCloudboardDatabase } from "./environment-store";

interface CostReportRow {
  report_json: string;
}

interface CostDetailSnapshotRow {
  comparison_available: number;
  total_items: number;
}

interface CostDetailRow {
  rank: number;
  service: string;
  usage_type: string | null;
  basis_cost_usd: number;
  weekday_median_cost_usd: number;
  increase_usd: number;
  increase_percentage: number | null;
  is_new: number;
}

export interface CostDetailSnapshot {
  comparisonAvailable: boolean;
  totalItems: number;
}

export interface CostDetailPage {
  snapshot: CostDetailSnapshot;
  items: CostIncreaseDetail[];
  nextCursor: number | null;
}

function database() {
  return getCloudboardDatabase();
}

export function saveCostAnomalyReport(report: CostAnomalyReport) {
  const instance = database();
  return instance.transaction(() => {
    const storedReport = { ...report, costIncreases: [] };
    const saved = instance.prepare(`
      INSERT INTO cost_anomaly_reports
        (environment_id, basis_date, generated_at, status, report_json)
      VALUES
        (@environmentId, @basisDate, @generatedAt, @status, @reportJson)
      ON CONFLICT(environment_id, basis_date) DO UPDATE SET
        generated_at = excluded.generated_at,
        status = excluded.status,
        report_json = excluded.report_json
      WHERE excluded.generated_at > cost_anomaly_reports.generated_at
    `)
    .run({
      environmentId: report.environmentId,
      basisDate: report.basisDate,
      generatedAt: report.generatedAt,
      status: report.status,
      reportJson: JSON.stringify(storedReport),
    });
    const updatedLatestReport = saved.changes > 0;
    const savedSnapshot = instance.prepare(`
      INSERT INTO cost_detail_snapshots
        (environment_id, basis_date, generated_at, comparison_available, total_items)
      VALUES
        (@environmentId, @basisDate, @generatedAt, @comparisonAvailable, @totalItems)
      ON CONFLICT(environment_id, basis_date, generated_at) DO UPDATE SET
        comparison_available = excluded.comparison_available,
        total_items = excluded.total_items
      WHERE @replaceSnapshot = 1
    `).run({
      environmentId: report.environmentId,
      basisDate: report.basisDate,
      generatedAt: report.generatedAt,
      comparisonAvailable: report.status === "insufficient-data" ? 0 : 1,
      totalItems: report.costIncreases.length,
      replaceSnapshot: updatedLatestReport ? 1 : 0,
    });
    if (savedSnapshot.changes > 0) {
      instance.prepare(`
        DELETE FROM cost_change_details
        WHERE environment_id = @environmentId
          AND basis_date = @basisDate
          AND generated_at = @generatedAt
      `).run({
        environmentId: report.environmentId,
        basisDate: report.basisDate,
        generatedAt: report.generatedAt,
      });
      const insertDetail = instance.prepare(`
        INSERT INTO cost_change_details
          (environment_id, basis_date, generated_at, rank, service, usage_type,
           basis_cost_usd, weekday_median_cost_usd, increase_usd,
           increase_percentage, is_new)
        VALUES
          (@environmentId, @basisDate, @generatedAt, @rank, @service, @usageType,
           @basisCostUsd, @weekdayMedianCostUsd, @increaseUsd,
           @increasePercentage, @isNew)
      `);
      report.costIncreases.forEach((item, rank) => {
        insertDetail.run({
          environmentId: report.environmentId,
          basisDate: report.basisDate,
          generatedAt: report.generatedAt,
          rank,
          service: item.service,
          usageType: item.usageType,
          basisCostUsd: item.basisCostUsd,
          weekdayMedianCostUsd: item.weekdayMedianCostUsd,
          increaseUsd: item.increaseUsd,
          increasePercentage: item.increasePercentage,
          isNew: item.isNew ? 1 : 0,
        });
      });
    }
    instance.prepare(`
      DELETE FROM cost_anomaly_reports
      WHERE environment_id = @environmentId
        AND basis_date NOT IN (
          SELECT basis_date
          FROM cost_anomaly_reports
          WHERE environment_id = @environmentId
          ORDER BY basis_date DESC
          LIMIT 90
        )
    `).run({ environmentId: report.environmentId });
    instance.prepare(`
      DELETE FROM cost_detail_snapshots
      WHERE environment_id = @environmentId
        AND (basis_date, generated_at) NOT IN (
          SELECT basis_date, generated_at
          FROM cost_detail_snapshots
          WHERE environment_id = @environmentId
          ORDER BY generated_at DESC
          LIMIT 90
        )
    `).run({ environmentId: report.environmentId });
    return updatedLatestReport;
  })();
}

export function getCostDetailSnapshot(
  environmentId: string,
  basisDate: string,
  generatedAt: string,
): CostDetailSnapshot | null {
  const row = database().prepare(`
    SELECT comparison_available, total_items
    FROM cost_detail_snapshots
    WHERE environment_id = ? AND basis_date = ? AND generated_at = ?
  `).get(environmentId, basisDate, generatedAt) as
    CostDetailSnapshotRow | undefined;
  return row
    ? {
        comparisonAvailable: row.comparison_available === 1,
        totalItems: row.total_items,
      }
    : null;
}

export function costIncreaseDetailsPage(
  environmentId: string,
  basisDate: string,
  generatedAt: string,
  cursor: number,
  limit: number,
): CostDetailPage | null {
  const instance = database();
  return instance.transaction(() => {
    const snapshot = getCostDetailSnapshot(
      environmentId,
      basisDate,
      generatedAt,
    );
    if (!snapshot) return null;
    const rows = instance.prepare(`
      SELECT rank, service, usage_type, basis_cost_usd,
             weekday_median_cost_usd, increase_usd,
             increase_percentage, is_new
      FROM cost_change_details
      WHERE environment_id = ? AND basis_date = ? AND generated_at = ?
        AND rank >= ?
      ORDER BY rank
      LIMIT ?
    `).all(
      environmentId,
      basisDate,
      generatedAt,
      cursor,
      limit + 1,
    ) as CostDetailRow[];
    const pageRows = rows.slice(0, limit);
    return {
      snapshot,
      nextCursor: rows.length > limit ? rows[limit].rank : null,
      items: pageRows.map((row) => ({
        service: row.service,
        usageType: row.usage_type,
        basisCostUsd: row.basis_cost_usd,
        weekdayMedianCostUsd: row.weekday_median_cost_usd,
        increaseUsd: row.increase_usd,
        increasePercentage: row.increase_percentage,
        isNew: row.is_new === 1,
      })),
    };
  })();
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
    costDetailsVersion: stored.costDetailsVersion ?? 0,
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
    topDrivers: (stored.topDrivers ?? []).map((driver) => ({
      ...driver,
      usageType: driver.usageType ?? null,
      baselineOccurrences: driver.baselineOccurrences ?? 0,
    })),
    costIncreases: [],
  };
}
