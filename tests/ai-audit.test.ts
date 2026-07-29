import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Response } from "openai/resources/responses/responses";
import type { AwsEnvironmentConfig } from "../lib/aws-config";
import type { AiAuditEvidence, AiAuditReport } from "../lib/cloudboard";
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
const auditRoute = await import("../app/api/reports/ai-audit/route");

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

test("stores and retrieves the latest AI audit report", () => {
  auditStore.saveAiAuditReport(report("2026-07-27T21:00:00.000Z", "첫 요약"));
  auditStore.saveAiAuditReport(report("2026-07-28T21:00:00.000Z", "최신 요약"));

  const latest = auditStore.latestAiAuditReport("dev");
  assert.ok(latest);
  assert.equal(latest.cost.headline, "최신 요약");
  assert.equal(latest.generatedAt, "2026-07-28T21:00:00.000Z");
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
  assert.deepEqual(versions.map((row) => row.version), [1, 2, 3]);
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('cost_anomaly_reports', 'ai_audit_reports') ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  assert.deepEqual(tables.map((row) => row.name), [
    "ai_audit_reports",
    "cost_anomaly_reports",
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

  const generated = await runAiAudit(config, {
    createResponse: async () => {
      const response = responses.shift();
      assert.ok(response);
      return response;
    },
    executeTool: async (context, name) => {
      executed.push(name);
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
  });

  assert.deepEqual(executed, toolNames);
  assert.equal(generated.cost.status, "normal");
  assert.equal(generated.resourceChanges.status, "normal");
  assert.equal(generated.toolCalls, 4);
});

test("returns the latest stored summary without generating a new one", async () => {
  process.env.CLOUDBOARD_ACCESS_TOKEN = "test-token";
  const response = await auditRoute.GET(
    new Request("http://cloudboard.test/api/reports/ai-audit?environment=dev", {
      headers: { "x-cloudboard-token": "test-token" },
    }),
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
  process.env.CLOUDBOARD_ACCESS_TOKEN = "test-token";
  const response = await auditRoute.POST(
    new Request("http://cloudboard.test/api/reports/ai-audit?environment=dev", {
      method: "POST",
      headers: { "x-cloudboard-token": "test-token" },
    }),
  );
  const body = (await response.json()) as { code: string };

  assert.equal(response.status, 503);
  assert.equal(body.code, "CONFIGURATION_ERROR");
});

test("rejects AI audit access when the server token is not configured", async () => {
  delete process.env.CLOUDBOARD_ACCESS_TOKEN;
  const response = await auditRoute.GET(
    new Request("http://cloudboard.test/api/reports/ai-audit?environment=dev"),
  );
  const body = (await response.json()) as { code: string };

  assert.equal(response.status, 503);
  assert.equal(body.code, "CONFIGURATION_ERROR");
});
