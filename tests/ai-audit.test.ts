import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Response } from "openai/resources/responses/responses";
import type { AwsEnvironmentConfig } from "../lib/aws-config";
import type {
  AiAuditEvidence,
  AiAuditReport,
  CostAnomalyReport,
} from "../lib/cloudboard";
import {
  normalizeAuditResult,
  runAiAudit,
} from "../lib/ai-audit-agent";

const testDirectory = mkdtempSync(join(tmpdir(), "cloudboard-ai-audit-"));
const bootstrapPath = join(testDirectory, "environments.json");
process.env.CLOUDBOARD_DATABASE_PATH = join(testDirectory, "cloudboard.db");
process.env.CLOUDBOARD_ENVIRONMENTS_BOOTSTRAP_FILE = bootstrapPath;

writeFileSync(
  bootstrapPath,
  JSON.stringify({
    environments: [
      {
        id: "dev",
        name: "Development",
        group: "Default",
        regions: ["ap-northeast-2"],
        credentialRef: "dev",
      },
    ],
  }),
);

const environmentStore = await import("../lib/environment-store");
const auditStore = await import("../lib/ai-audit-store");
const costStore = await import("../lib/cost-report-store");
const aiAuditTools = await import("../lib/ai-audit-tools");
const auditRoute = await import("../app/api/reports/ai-audit/route");
const dailyCostRoute = await import("../app/api/reports/daily-cost/route");
const costDetailsRoute = await import("../app/api/reports/cost-details/route");

test.after(() => {
  environmentStore.closeEnvironmentStore();
});

function report(generatedAt: string, headline: string): AiAuditReport {
  return {
    environmentId: "dev",
    environmentName: "Development",
    generatedAt,
    status: "ready",
    model: "gpt-5.6-sol",
    costBasis: {
      expectedBasisDate: "2026-07-27",
      basisDate: "2026-07-27",
      dataStatus: "ready",
      freshnessDays: 2,
    },
    costChanges: {
      comparison: "same-weekday-median",
      comparisonAvailable: true,
      basisDate: "2026-07-27",
      reportGeneratedAt: generatedAt,
      baselineDates: [],
      totalItems: 0,
    },
    cost: {
      status: "normal",
      headline,
      summary: "비용 변동이 없습니다.",
      highlights: [],
      evidenceIds: ["cost-1"],
    },
    resourceChanges: {
      status: "normal",
      headline: "자원 변경 없음",
      summary: "최근 변경이 없습니다.",
      highlights: [],
      evidenceIds: ["cloudtrail-1"],
    },
    evidence: [
      {
        id: "cost-1",
        source: "cost-explorer",
        kind: "cost-analysis",
        label: "비용 비교",
        detail: "비용 근거",
        observedAt: generatedAt,
      },
      {
        id: "cloudtrail-1",
        source: "cloudtrail",
        kind: "cloudtrail-query-window",
        label: "변경 조회",
        detail: "변경 없음",
        observedAt: generatedAt,
      },
    ],
    limitations: [],
    toolCalls: 4,
  };
}

function costReport(
  basisDate: string,
  expectedBasisDate: string,
  generatedAt: string,
): CostAnomalyReport {
  return {
    environmentId: "dev",
    environmentName: "Development",
    generatedAt,
    expectedBasisDate,
    basisDate,
    dataStatus: basisDate === expectedBasisDate ? "ready" : "delayed",
    freshnessDays: basisDate === expectedBasisDate ? 2 : 3,
    costIsEstimated: true,
    metric: "NetAmortizedCost",
    costDetailsVersion: 1,
    status: "normal",
    totalCostUsd: 100,
    weekdayMedianUsd: 100,
    weekdayChangeUsd: 0,
    weekdayChangePercentage: 0,
    previousBasisDate: null,
    previousBasisCostUsd: null,
    previousBasisChangeUsd: null,
    previousBasisChangePercentage: null,
    baselineDates: [],
    thresholds: { relativePercentage: 20, absoluteUsd: 100 },
    topDrivers: [],
    costIncreases: [],
    message: "정상",
  };
}

test("stores and retrieves the latest AI audit report", () => {
  auditStore.saveAiAuditReport(report("2026-07-27T21:00:00.000Z", "첫 요약"));
  auditStore.saveAiAuditReport(report("2026-07-28T21:00:00.000Z", "최신 요약"));

  const latest = auditStore.latestAiAuditReport("dev");
  assert.ok(latest);
  assert.equal(latest.cost.headline, "최신 요약");
  assert.equal(latest.generatedAt, "2026-07-28T21:00:00.000Z");
});

test("returns the most recently generated cost report after the T-2 policy change", () => {
  costStore.saveCostAnomalyReport(
    costReport("2026-07-28", "2026-07-28", "2026-07-29T06:00:00.000Z"),
  );
  costStore.saveCostAnomalyReport(
    costReport("2026-07-27", "2026-07-27", "2026-07-29T07:00:00.000Z"),
  );

  const latest = costStore.latestCostAnomalyReport("dev");
  assert.equal(latest?.basisDate, "2026-07-27");
  assert.equal(latest?.generatedAt, "2026-07-29T07:00:00.000Z");
});

test("does not let an older overlapping cost run overwrite a newer report", () => {
  const newerSaved = costStore.saveCostAnomalyReport(
    costReport("2026-07-27", "2026-07-27", "2026-07-29T07:10:00.000Z"),
  );
  const olderSaved = costStore.saveCostAnomalyReport(
    costReport("2026-07-27", "2026-07-27", "2026-07-29T07:05:00.000Z"),
  );

  const latest = costStore.latestCostAnomalyReport("dev");
  const olderSnapshot = costStore.getCostDetailSnapshot(
    "dev",
    "2026-07-27",
    "2026-07-29T07:05:00.000Z",
  );
  assert.equal(newerSaved, true);
  assert.equal(olderSaved, false);
  assert.equal(latest?.generatedAt, "2026-07-29T07:10:00.000Z");
  assert.ok(olderSnapshot);
});

test("keeps the first committed snapshot when generated timestamps tie", () => {
  const generatedAt = "2026-07-29T07:20:00.000Z";
  const first = costReport("2026-07-27", "2026-07-27", generatedAt);
  first.costIncreases = [{
    service: "Amazon EC2",
    usageType: "BoxUsage:t3.large",
    basisCostUsd: 20,
    weekdayMedianCostUsd: 10,
    increaseUsd: 10,
    increasePercentage: 100,
    isNew: false,
  }];
  const tied = costReport("2026-07-27", "2026-07-27", generatedAt);
  tied.costIncreases = [
    ...first.costIncreases,
    {
      service: "Amazon RDS",
      usageType: "InstanceUsage:db.r6g.large",
      basisCostUsd: 30,
      weekdayMedianCostUsd: 10,
      increaseUsd: 20,
      increasePercentage: 200,
      isNew: false,
    },
  ];

  assert.equal(costStore.saveCostAnomalyReport(first), true);
  assert.equal(costStore.saveCostAnomalyReport(tied), false);
  const snapshot = costStore.getCostDetailSnapshot(
    "dev",
    "2026-07-27",
    generatedAt,
  );
  const page = costStore.costIncreaseDetailsPage(
    "dev",
    "2026-07-27",
    generatedAt,
    0,
    100,
  );
  assert.equal(snapshot?.totalItems, 1);
  assert.deepEqual(page?.items.map((item) => item.service), ["Amazon EC2"]);
});

test("normalizes a legacy T-2 cost report to the current API contract", () => {
  const legacy = {
    ...costReport("2026-07-25", "2026-07-25", "2026-07-29T08:00:00.000Z"),
    previousFinalizedDate: "2026-07-24",
    previousFinalizedCostUsd: 90,
    previousDayChangeUsd: 10,
    previousDayChangePercentage: 11.11,
  } as unknown as Record<string, unknown>;
  delete legacy.expectedBasisDate;
  delete legacy.dataStatus;
  delete legacy.previousBasisDate;
  delete legacy.previousBasisCostUsd;
  delete legacy.previousBasisChangeUsd;
  delete legacy.previousBasisChangePercentage;
  costStore.saveCostAnomalyReport(legacy as unknown as CostAnomalyReport);

  const latest = costStore.latestCostAnomalyReport(
    "dev",
    new Date("2026-07-29T06:00:00.000Z"),
  );
  assert.equal(latest?.expectedBasisDate, "2026-07-27");
  assert.equal(latest?.dataStatus, "delayed");
  assert.equal(latest?.freshnessDays, 4);
  assert.equal(latest?.previousBasisDate, "2026-07-24");
  assert.equal(latest?.previousBasisCostUsd, 90);
  assert.equal(latest?.previousBasisChangeUsd, 10);
  assert.equal(latest?.previousBasisChangePercentage, 11.11);
  assert.equal("previousFinalizedDate" in (latest ?? {}), false);
});

test("does not reuse an AI report after the KST T-2 basis rolls over", () => {
  const recent = report("2026-07-29T14:59:00.000Z", "자정 직전 요약");

  assert.equal(
    auditRoute.aiAuditReportIsReusable(
      recent,
      new Date("2026-07-29T14:59:30.000Z"),
      300_000,
    ),
    true,
  );
  assert.equal(
    auditRoute.aiAuditReportIsReusable(
      recent,
      new Date("2026-07-29T15:01:00.000Z"),
      300_000,
    ),
    false,
  );
  assert.equal(
    auditRoute.aiAuditReportMatchesCurrentBasis(
      recent,
      new Date("2026-07-29T15:01:00.000Z"),
    ),
    false,
  );
});

test("uses separate in-flight run keys after the KST T-2 basis rolls over", () => {
  const beforeMidnight = new Date("2026-07-29T14:59:00.000Z");
  const afterMidnight = new Date("2026-07-29T15:01:00.000Z");

  assert.equal(
    auditRoute.aiAuditRunKey("dev", beforeMidnight),
    "dev:2026-07-27",
  );
  assert.equal(
    auditRoute.aiAuditRunKey("dev", afterMidnight),
    "dev:2026-07-28",
  );
});

test("retries delayed cost data after the short reuse interval", () => {
  const now = new Date("2026-07-29T08:10:00.000Z");
  const delayed = costReport(
    "2026-07-26",
    "2026-07-27",
    "2026-07-29T08:00:00.000Z",
  );
  assert.equal(
    aiAuditTools.costReportIsReusableForAudit(delayed, true, now),
    false,
  );

  delayed.generatedAt = "2026-07-29T08:08:00.000Z";
  assert.equal(
    aiAuditTools.costReportIsReusableForAudit(delayed, true, now),
    true,
  );

  delayed.dataStatus = "ready";
  delayed.generatedAt = "2026-07-29T06:00:00.000Z";
  assert.equal(
    aiAuditTools.costReportIsReusableForAudit(delayed, true, now),
    true,
  );
});

test("returns cost increase details in bounded pages", async () => {
  const detailed = costReport(
    "2026-07-27",
    "2026-07-27",
    "2026-07-29T08:00:00.000Z",
  );
  detailed.costIncreases = [
    {
      service: "Amazon EC2",
      usageType: "BoxUsage:t3.large",
      basisCostUsd: 80,
      weekdayMedianCostUsd: 50,
      increaseUsd: 30,
      increasePercentage: 60,
      isNew: false,
    },
    {
      service: "Amazon RDS",
      usageType: "InstanceUsage:db.r6g.large",
      basisCostUsd: 40,
      weekdayMedianCostUsd: 0,
      increaseUsd: 40,
      increasePercentage: null,
      isNew: true,
    },
  ];
  costStore.saveCostAnomalyReport(detailed);

  const response = await costDetailsRoute.GET(
    new Request(
      "http://cloudboard.test/api/reports/cost-details?environment=dev&basisDate=2026-07-27&reportGeneratedAt=2026-07-29T08%3A00%3A00.000Z&cursor=1&limit=1",
    ),
  );
  const body = (await response.json()) as {
    reportGeneratedAt: string;
    total: number;
    items: Array<{ service: string }>;
  };

  assert.equal(response.status, 200);
  assert.equal(body.reportGeneratedAt, "2026-07-29T08:00:00.000Z");
  assert.equal(body.total, 2);
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].service, "Amazon RDS");

  const defaultPageResponse = await costDetailsRoute.GET(
    new Request(
      "http://cloudboard.test/api/reports/cost-details?environment=dev&basisDate=2026-07-27&reportGeneratedAt=2026-07-29T08%3A00%3A00.000Z",
    ),
  );
  const defaultPage = (await defaultPageResponse.json()) as {
    limit: number;
    items: Array<{ service: string }>;
  };
  assert.equal(defaultPage.limit, 100);
  assert.equal(defaultPage.items.length, 2);
});

test("rejects a cost detail page from a different report snapshot", async () => {
  const response = await costDetailsRoute.GET(
    new Request(
      "http://cloudboard.test/api/reports/cost-details?environment=dev&basisDate=2026-07-27&reportGeneratedAt=2026-07-29T09%3A00%3A00.000Z",
    ),
  );

  assert.equal(response.status, 409);
});

test("returns cost report metadata without pretending omitted details are empty", async () => {
  const response = await dailyCostRoute.GET(
    new Request("http://cloudboard.test/api/reports/daily-cost?environment=dev"),
  );
  const body = (await response.json()) as {
    report: Record<string, unknown> & { costIncreaseCount: number };
  };

  assert.equal(response.status, 200);
  assert.equal(body.report.costIncreaseCount, 2);
  assert.equal("costIncreases" in body.report, false);
});

test("keeps a legacy summary visible but does not reuse it for generation", () => {
  const legacy = report("2026-07-29T05:59:00.000Z", "기존 요약") as
    Partial<AiAuditReport>;
  delete legacy.costChanges;
  const now = new Date("2026-07-29T06:00:00.000Z");

  assert.equal(
    auditRoute.aiAuditReportMatchesCurrentBasis(legacy as AiAuditReport, now),
    true,
  );
  assert.equal(
    auditRoute.aiAuditReportIsReusable(
      legacy as AiAuditReport,
      now,
      300_000,
    ),
    false,
  );
});

test("removes invented evidence from the two summaries", () => {
  const evidence = new Map<string, AiAuditEvidence>([
    [
      "cost-1",
      {
        id: "cost-1",
        source: "cost-explorer",
        kind: "cost-analysis",
        label: "비용 비교",
        detail: "비용 근거",
        observedAt: null,
      },
    ],
  ]);
  const normalized = normalizeAuditResult(
    {
      cost: {
        status: "attention",
        headline: "비용 증가",
        summary: "EC2 비용이 증가했습니다.",
        highlights: ["EC2 +20 USD"],
        evidenceIds: ["cost-1", "invented-evidence"],
      },
      resourceChanges: {
        status: "critical",
        headline: "근거 없는 변경",
        summary: "리소스가 삭제됐습니다.",
        highlights: ["삭제 이벤트"],
        evidenceIds: ["invented-evidence"],
      },
      limitations: [],
    },
    evidence,
  );

  assert.equal(normalized.cost.status, "attention");
  assert.deepEqual(normalized.cost.evidenceIds, ["cost-1"]);
  assert.equal(normalized.resourceChanges.status, "unavailable");
  assert.deepEqual(normalized.resourceChanges.evidenceIds, []);
});

test("rejects evidence from the wrong summary category", () => {
  const evidence = new Map<string, AiAuditEvidence>([
    [
      "cost-1",
      {
        id: "cost-1",
        source: "cost-explorer",
        kind: "cost-analysis",
        label: "비용 비교",
        detail: "비용 근거",
        observedAt: null,
      },
    ],
    [
      "config-capture-1",
      {
        id: "config-capture-1",
        source: "aws-config",
        kind: "config-capture",
        label: "구성 캡처",
        detail: "변경 여부 미확인",
        observedAt: null,
      },
    ],
  ]);
  const normalized = normalizeAuditResult(
    {
      cost: {
        status: "attention",
        headline: "잘못된 비용 근거",
        summary: "CloudTrail만 인용",
        highlights: [],
        evidenceIds: ["config-capture-1"],
      },
      resourceChanges: {
        status: "critical",
        headline: "검증되지 않은 변경",
        summary: "캡처만 인용",
        highlights: [],
        evidenceIds: ["config-capture-1"],
      },
      limitations: [],
    },
    evidence,
  );

  assert.equal(normalized.cost.status, "unavailable");
  assert.equal(normalized.resourceChanges.status, "unavailable");
});

test("applies all SQLite migrations during store startup", () => {
  const database = environmentStore.getCloudboardDatabase();
  const versions = database
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: number }>;
  assert.deepEqual(versions.map((row) => row.version), [1, 2, 3, 4]);
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('cost_anomaly_reports', 'ai_audit_reports', 'cost_detail_snapshots', 'cost_change_details') ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  assert.deepEqual(tables.map((row) => row.name), [
    "ai_audit_reports",
    "cost_anomaly_reports",
    "cost_change_details",
    "cost_detail_snapshots",
  ]);
});

test("runs the required evidence tools before accepting an AI summary", async () => {
  const toolNames = [
    "get_environment_overview",
    "get_cost_analysis",
    "list_recent_write_events",
    "list_recent_configurations",
  ];
  const responses: Array<Pick<Response, "output" | "output_text">> = [
    {
      output: toolNames.map((name, index) => ({
        type: "function_call",
        id: `item-${index}`,
        call_id: `call-${index}`,
        name,
        arguments:
          name.startsWith("list_recent")
            ? JSON.stringify({ hours: 24, limit: 50 })
            : "{}",
        status: "completed",
      })) as Response["output"],
      output_text: "",
    },
    {
      output: [],
      output_text: JSON.stringify({
        cost: {
          status: "normal",
          headline: "비용 변동 없음",
          summary: "완료된 비용 기준으로 큰 변동이 없습니다.",
          highlights: [],
          evidenceIds: ["cost-1"],
        },
        resourceChanges: {
          status: "normal",
          headline: "자원 변경 없음",
          summary: "24시간 내 성공한 변경 이벤트가 없습니다.",
          highlights: [],
          evidenceIds: ["cloudtrail-window-1"],
        },
        limitations: [],
      }),
    },
  ];
  const executed: string[] = [];
  const config: AwsEnvironmentConfig = {
    id: "dev",
    name: "Development",
    regions: ["ap-northeast-2"],
    credentials: {
      accessKeyId: "test",
      secretAccessKey: "test",
    },
  };

  const auditNow = new Date("2026-07-29T06:00:00.000Z");
  const generated = await runAiAudit(config, {
    createResponse: async () => {
      const response = responses.shift();
      assert.ok(response);
      return response;
    },
    executeTool: async (context, name) => {
      executed.push(name);
      assert.equal(context.now.toISOString(), auditNow.toISOString());
      if (name === "get_cost_analysis") {
        context.costBasis = {
          expectedBasisDate: "2026-07-27",
          basisDate: "2026-07-27",
          dataStatus: "ready",
          freshnessDays: 2,
        };
        context.costChanges = {
          comparison: "same-weekday-median",
          comparisonAvailable: true,
          basisDate: "2026-07-27",
          reportGeneratedAt: auditNow.toISOString(),
          baselineDates: ["2026-07-20", "2026-07-13"],
          totalItems: 1,
        };
      }
      const evidenceByTool: Record<string, AiAuditEvidence> = {
        get_environment_overview: {
          id: "inventory-1",
          source: "inventory",
          kind: "inventory-overview",
          label: "자원 현황",
          detail: "현황",
          observedAt: null,
        },
        get_cost_analysis: {
          id: "cost-1",
          source: "cost-explorer",
          kind: "cost-analysis",
          label: "비용 비교",
          detail: "비용 근거",
          observedAt: null,
        },
        list_recent_write_events: {
          id: "cloudtrail-window-1",
          source: "cloudtrail",
          kind: "cloudtrail-query-window",
          label: "변경 조회",
          detail: "변경 없음",
          observedAt: null,
        },
        list_recent_configurations: {
          id: "config-window-1",
          source: "aws-config",
          kind: "config-query-window",
          label: "구성 조회",
          detail: "구성 조회 완료",
          observedAt: null,
        },
      };
      const evidence = evidenceByTool[name];
      if (evidence) context.evidence.set(evidence.id, evidence);
      return { ok: true, evidenceId: evidence?.id };
    },
  }, auditNow);

  assert.deepEqual(executed, toolNames);
  assert.equal(generated.cost.status, "normal");
  assert.equal(generated.resourceChanges.status, "normal");
  assert.equal(generated.toolCalls, 4);
  assert.deepEqual(generated.costBasis, {
    expectedBasisDate: "2026-07-27",
    basisDate: "2026-07-27",
    dataStatus: "ready",
    freshnessDays: 2,
  });
  assert.equal(generated.costChanges.totalItems, 1);
  assert.equal(generated.generatedAt, auditNow.toISOString());
});

test("returns the latest stored summary without generating a new one", async () => {
  const response = await auditRoute.GET(
    new Request("http://cloudboard.test/api/reports/ai-audit?environment=dev"),
  );
  const body = (await response.json()) as {
    configured: boolean;
    report: AiAuditReport | null;
  };

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.configured, false);
  assert.equal(body.report?.cost.headline, "최신 요약");
});

test("rejects generation when the OpenAI key is not configured", async () => {
  delete process.env.OPENAI_API_KEY;
  const response = await auditRoute.POST(
    new Request("http://cloudboard.test/api/reports/ai-audit?environment=dev", {
      method: "POST",
    }),
  );
  const body = (await response.json()) as { code: string };

  assert.equal(response.status, 503);
  assert.equal(body.code, "CONFIGURATION_ERROR");
});
