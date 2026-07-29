import {
  CloudTrailClient,
  LookupEventsCommand,
} from "@aws-sdk/client-cloudtrail";
import {
  ConfigServiceClient,
  GetResourceConfigHistoryCommand,
  SelectResourceConfigCommand,
  type ResourceType,
} from "@aws-sdk/client-config-service";
import { scanEnvironment } from "./aws-scanner";
import type { AwsEnvironmentConfig } from "./aws-config";
import type { AiAuditEvidence } from "./cloudboard";
import { generateCostAnomalyReport } from "./cost-anomaly";

type JsonObject = Record<string, unknown>;

export interface AiAuditToolContext {
  config: AwsEnvironmentConfig;
  evidence: Map<string, AiAuditEvidence>;
  limitations: string[];
}

export const aiAuditToolDefinitions = [
  {
    type: "function" as const,
    name: "get_environment_overview",
    description:
      "Get the current AWS inventory, RI/Savings Plans coverage, utilization, expiry, and deterministic findings.",
    strict: true,
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function" as const,
    name: "get_cost_analysis",
    description:
      "Get the latest completed AWS cost date, same-weekday baseline, previous day comparison, and top cost drivers.",
    strict: true,
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function" as const,
    name: "list_recent_write_events",
    description:
      "List recent CloudTrail management events that may have changed AWS resources. Read-only calls are filtered out.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        hours: { type: "integer", minimum: 1, maximum: 168 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["hours", "limit"],
      additionalProperties: false,
    },
  },
  {
    type: "function" as const,
    name: "list_recent_configurations",
    description:
      "List resources recently captured by AWS Config. Capture time is evidence of observation, not proof that a resource changed.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        hours: { type: "integer", minimum: 1, maximum: 168 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["hours", "limit"],
      additionalProperties: false,
    },
  },
  {
    type: "function" as const,
    name: "get_resource_history",
    description:
      "Compare recent AWS Config versions for one resource and return sanitized changed fields. Use it to verify a suspected change.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        resourceType: { type: "string", minLength: 3, maxLength: 120 },
        resourceId: { type: "string", minLength: 1, maxLength: 512 },
        region: { type: "string", minLength: 3, maxLength: 32 },
        hours: { type: "integer", minimum: 1, maximum: 720 },
      },
      required: ["resourceType", "resourceId", "region", "hours"],
      additionalProperties: false,
    },
  },
];

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function stringArgument(value: unknown, field: string, maximum: number) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return value.trim().slice(0, maximum);
}

function evidenceId(prefix: string, ...parts: Array<string | number | null>) {
  const safe = parts
    .filter((part) => part !== null)
    .join("-")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 96);
  return `${prefix}-${safe || "item"}`;
}

function addEvidence(
  context: AiAuditToolContext,
  evidence: AiAuditEvidence,
) {
  let id = evidence.id;
  let suffix = 2;
  while (context.evidence.has(id)) {
    id = `${evidence.id}-${suffix}`;
    suffix += 1;
  }
  const stored = { ...evidence, id };
  context.evidence.set(id, stored);
  return stored;
}

function safeMessage(error: unknown) {
  if (!(error instanceof Error)) {
    return "AWS 요청을 완료하지 못했습니다.";
  }
  const name = error.name || "AwsError";
  if (/accessdenied|unauthorized|forbidden/i.test(`${name} ${error.message}`)) {
    return `${name}: 필요한 읽기 전용 권한이 없습니다.`;
  }
  return `${name}: AWS 요청을 완료하지 못했습니다.`;
}

function parseCloudTrailEvent(value: string | undefined): JsonObject {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : {};
  } catch {
    return {};
  }
}

function actorFromEvent(event: JsonObject) {
  const identity = event.userIdentity;
  if (typeof identity !== "object" || identity === null) {
    return null;
  }
  const record = identity as JsonObject;
  for (const value of [record.arn, record.principalId, record.type]) {
    if (typeof value === "string" && value) {
      return value.slice(0, 240);
    }
  }
  return null;
}

function isWriteEvent(name: string, detail: JsonObject) {
  if (detail.readOnly === true || detail.eventCategory === "Data") {
    return false;
  }
  return !/^(Get|List|Describe|Head|Lookup|BatchGet|Search|View)/.test(name);
}

async function environmentOverview(context: AiAuditToolContext) {
  const report = await scanEnvironment(context.config);
  const evidence = addEvidence(context, {
    id: evidenceId("inventory", report.generatedAt),
    source: "inventory",
    kind: "inventory-overview",
    label: "현재 자원 및 RI·SP 현황",
    detail: `${report.services.reduce((sum, item) => sum + item.running, 0)}개 실행 자원, ${report.reservations.length}개 RI 계약 항목, ${report.savingsPlans.length}개 Savings Plan을 조회했습니다.`,
    observedAt: report.generatedAt,
  });
  return {
    evidenceId: evidence.id,
    accountId: report.accountId,
    regions: report.regions,
    status: report.status,
    services: report.services.map((service) => ({
      service: service.name,
      running: service.running,
      activeRiQuantity: service.reserved,
      riCoveragePercentage: service.riCoveragePercentage,
      coverageLevel: service.coverageLevel,
      errors: service.errors,
    })),
    savingsPlansCoverage: report.savingsPlansCoverage,
    metrics: {
      ri: {
        coverage: report.metrics.ri.coverage,
        utilization: report.metrics.ri.utilization,
        netSavingsUsd: report.metrics.ri.netSavingsUsd,
        unusedCommitmentUsd: report.metrics.ri.unusedCommitmentUsd,
        uncoveredOnDemandUsd: report.metrics.ri.uncoveredOnDemandUsd,
      },
      savingsPlans: {
        coverage: report.metrics.savingsPlans.coverage,
        utilization: report.metrics.savingsPlans.utilization,
        netSavingsUsd: report.metrics.savingsPlans.netSavingsUsd,
        unusedCommitmentUsd: report.metrics.savingsPlans.unusedCommitmentUsd,
        uncoveredOnDemandUsd: report.metrics.savingsPlans.uncoveredOnDemandUsd,
      },
    },
    commitments: {
      reservationCount: report.reservations.length,
      savingsPlanCount: report.savingsPlans.length,
    },
    deterministicFindings: report.findings.slice(0, 10).map((finding) => ({
      severity: finding.severity,
      title: finding.title,
      service: finding.service,
      impactUsd: finding.impactUsd,
    })),
  };
}

async function costAnalysis(context: AiAuditToolContext) {
  const report = await generateCostAnomalyReport(context.config);
  if (!report) {
    context.limitations.push("완료된 AWS 일별 비용 데이터가 없습니다.");
    return { available: false };
  }
  const evidence = addEvidence(context, {
    id: evidenceId("cost", report.basisDate),
    source: "cost-explorer",
    kind: "cost-analysis",
    label: `${report.basisDate} 비용 비교`,
    detail: `${report.metric} ${report.totalCostUsd} USD, 동일 요일 중앙값 대비 ${report.weekdayChangeUsd ?? "비교 불가"} USD, 판정 ${report.status}.`,
    observedAt: `${report.basisDate}T23:59:59.000Z`,
  });
  return { available: true, evidenceId: evidence.id, ...report };
}

async function recentWriteEvents(
  context: AiAuditToolContext,
  args: JsonObject,
) {
  const hours = boundedInteger(args.hours, 24, 1, 168);
  const limit = boundedInteger(args.limit, 50, 1, 100);
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3_600_000);
  const events: JsonObject[] = [];
  const errors: string[] = [];

  await Promise.all(
    context.config.regions.map(async (region) => {
      try {
        const client = new CloudTrailClient({
          region,
          credentials: context.config.credentials,
          maxAttempts: 2,
        });
        let nextToken: string | undefined;
        let pages = 0;
        do {
          pages += 1;
          const response = await client.send(
            new LookupEventsCommand({
              StartTime: start,
              EndTime: end,
              MaxResults: 50,
              NextToken: nextToken,
            }),
            { abortSignal: AbortSignal.timeout(30_000) },
          );
          for (const event of response.Events ?? []) {
            const eventName = event.EventName ?? "UnknownEvent";
            const detail = parseCloudTrailEvent(event.CloudTrailEvent);
            if (!isWriteEvent(eventName, detail)) {
              continue;
            }
            const observedAt = event.EventTime?.toISOString() ?? null;
            const resources = (event.Resources ?? [])
              .map((resource) => resource.ResourceName ?? resource.ResourceType)
              .filter((value): value is string => Boolean(value))
              .slice(0, 8);
            const evidence = addEvidence(context, {
              id: evidenceId("cloudtrail", event.EventId ?? eventName, region),
              source: "cloudtrail",
              kind:
                typeof detail.errorCode === "string"
                  ? "cloudtrail-failed-event"
                  : "cloudtrail-change-event",
              label: `${event.EventSource ?? "AWS"} ${eventName}`,
              detail: `${actorFromEvent(detail) ?? event.Username ?? "행위자 미상"} · ${resources.join(", ") || "리소스 식별자 없음"} · ${region}`,
              observedAt,
            });
            events.push({
              evidenceId: evidence.id,
              eventTime: observedAt,
              eventSource: event.EventSource ?? null,
              eventName,
              actor: actorFromEvent(detail) ?? event.Username ?? null,
              resources,
              errorCode:
                typeof detail.errorCode === "string" ? detail.errorCode : null,
              region,
            });
          }
          nextToken = response.NextToken;
        } while (nextToken && events.length < limit * 2 && pages < 4);
        if (nextToken) {
          errors.push(`${region}: 조회 결과가 제한을 초과해 일부만 확인했습니다.`);
        }
      } catch (error) {
        errors.push(`${region}: ${safeMessage(error)}`);
      }
    }),
  );

  if (errors.length > 0) {
    context.limitations.push(`CloudTrail 일부 조회 실패: ${errors.join(" / ")}`);
  }
  const queryEvidence = addEvidence(context, {
    id: evidenceId("cloudtrail-window", start.toISOString(), end.toISOString()),
    source: "cloudtrail",
    kind:
      errors.length === 0
        ? "cloudtrail-query-window"
        : "cloudtrail-query-incomplete",
    label: `최근 ${hours}시간 CloudTrail 변경 조회`,
    detail: `읽기 이벤트를 제외한 관리 이벤트 ${events.length}건을 확인했습니다.${errors.length > 0 ? ` ${errors.length}개 리전은 조회하지 못했습니다.` : ""}`,
    observedAt: end.toISOString(),
  });
  return {
    evidenceId: queryEvidence.id,
    window: { start: start.toISOString(), end: end.toISOString() },
    events: events
      .sort((left, right) =>
        String(right.eventTime).localeCompare(String(left.eventTime)),
      )
      .slice(0, limit),
    errors,
  };
}

async function recentConfigurations(
  context: AiAuditToolContext,
  args: JsonObject,
) {
  const hours = boundedInteger(args.hours, 24, 1, 168);
  const limit = boundedInteger(args.limit, 50, 1, 100);
  const cutoff = Date.now() - hours * 3_600_000;
  const cutoffIso = new Date(cutoff).toISOString();
  const endIso = new Date().toISOString();
  const resources: JsonObject[] = [];
  const errors: string[] = [];

  await Promise.all(
    context.config.regions.map(async (region) => {
      try {
        const client = new ConfigServiceClient({
          region,
          credentials: context.config.credentials,
          maxAttempts: 2,
        });
        let nextToken: string | undefined;
        let pages = 0;
        do {
          pages += 1;
          const response = await client.send(
            new SelectResourceConfigCommand({
              Expression:
                `SELECT resourceType, resourceId, resourceName, awsRegion, configurationItemCaptureTime, configurationItemStatus WHERE configurationItemCaptureTime BETWEEN '${cutoffIso}' AND '${endIso}' ORDER BY configurationItemCaptureTime DESC`,
              Limit: 100,
              NextToken: nextToken,
            }),
            { abortSignal: AbortSignal.timeout(30_000) },
          );
          for (const value of response.Results ?? []) {
            try {
              const item = JSON.parse(value) as JsonObject;
              const capturedAt =
                typeof item.configurationItemCaptureTime === "string"
                  ? item.configurationItemCaptureTime
                  : null;
              if (!capturedAt || new Date(capturedAt).getTime() < cutoff) {
                continue;
              }
              const resourceType = String(item.resourceType ?? "Unknown");
              const resourceId = String(item.resourceId ?? item.resourceName ?? "Unknown");
              const evidence = addEvidence(context, {
                id: evidenceId("config", resourceType, resourceId, capturedAt),
                source: "aws-config",
                kind: "config-capture",
                label: `${resourceType} 구성 기록`,
                detail: `${resourceId} · ${item.configurationItemStatus ?? "상태 미상"} · ${region}. 캡처 시각만으로 변경 여부를 확정할 수 없습니다.`,
                observedAt: capturedAt,
              });
              resources.push({
                evidenceId: evidence.id,
                resourceType,
                resourceId,
                resourceName: item.resourceName ?? null,
                region: item.awsRegion ?? region,
                capturedAt,
                status: item.configurationItemStatus ?? null,
              });
            } catch {
              // Ignore a malformed advanced-query row without failing the region.
            }
          }
          nextToken = response.NextToken;
        } while (nextToken && resources.length < limit * 4 && pages < 5);
        if (nextToken) {
          errors.push(`${region}: 조회 결과가 제한을 초과해 일부만 확인했습니다.`);
        }
      } catch (error) {
        errors.push(`${region}: ${safeMessage(error)}`);
      }
    }),
  );

  if (errors.length > 0) {
    context.limitations.push(`AWS Config 일부 조회 실패: ${errors.join(" / ")}`);
  }
  const queryEvidence = addEvidence(context, {
    id: evidenceId("config-window", hours, new Date().toISOString()),
    source: "aws-config",
    kind:
      errors.length === 0
        ? "config-query-window"
        : "config-query-incomplete",
    label: `최근 ${hours}시간 AWS Config 기록 조회`,
    detail: `최근 캡처된 구성 ${resources.length}건을 확인했습니다. 캡처 시각만으로 변경 여부를 확정하지 않습니다.${errors.length > 0 ? ` ${errors.length}개 리전은 조회하지 못했습니다.` : ""}`,
    observedAt: new Date().toISOString(),
  });
  return {
    evidenceId: queryEvidence.id,
    observation: "These are recently captured resources, not confirmed changes.",
    resources: resources
      .sort((left, right) =>
        String(right.capturedAt).localeCompare(String(left.capturedAt)),
      )
      .slice(0, limit),
    errors,
  };
}

const sensitiveKey = /secret|password|token|credential|private.?key|user.?data/i;

function valueType(value: unknown) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

interface Difference {
  path: string;
  beforeType: string;
  afterType: string;
}

function differences(
  before: unknown,
  after: unknown,
  path = "configuration",
  output: Difference[] = [],
) {
  if (output.length >= 40 || JSON.stringify(before) === JSON.stringify(after)) {
    return output;
  }
  if (
    typeof before === "object" &&
    before !== null &&
    !Array.isArray(before) &&
    typeof after === "object" &&
    after !== null &&
    !Array.isArray(after)
  ) {
    const keys = new Set([
      ...Object.keys(before as JsonObject),
      ...Object.keys(after as JsonObject),
    ]);
    for (const key of keys) {
      if (sensitiveKey.test(key)) {
        continue;
      }
      differences(
        (before as JsonObject)[key],
        (after as JsonObject)[key],
        `${path}.${key}`,
        output,
      );
      if (output.length >= 40) {
        break;
      }
    }
    return output;
  }
  output.push({
    path: path.slice(0, 300),
    beforeType: valueType(before),
    afterType: valueType(after),
  });
  return output;
}

async function resourceHistory(context: AiAuditToolContext, args: JsonObject) {
  const resourceType = stringArgument(args.resourceType, "resourceType", 120);
  const resourceId = stringArgument(args.resourceId, "resourceId", 512);
  const region = stringArgument(args.region, "region", 32);
  const hours = boundedInteger(args.hours, 72, 1, 720);
  if (!context.config.regions.includes(region)) {
    throw new Error("region is not registered for this environment.");
  }
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3_600_000);
  const client = new ConfigServiceClient({
    region,
    credentials: context.config.credentials,
    maxAttempts: 2,
  });
  const response = await client.send(
    new GetResourceConfigHistoryCommand({
      resourceType: resourceType as ResourceType,
      resourceId,
      earlierTime: start,
      laterTime: end,
      chronologicalOrder: "Reverse",
      limit: 10,
    }),
    { abortSignal: AbortSignal.timeout(30_000) },
  );
  const items = response.configurationItems ?? [];
  const latest = items[0];
  const previous = items[1];
  const parseConfiguration = (value: string | undefined) => {
    if (!value) return null;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  };
  const latestConfiguration = parseConfiguration(latest?.configuration);
  const previousConfiguration = parseConfiguration(previous?.configuration);
  const changedFields = previous
    ? differences(previousConfiguration, latestConfiguration)
    : [];
  const observedAt = latest?.configurationItemCaptureTime?.toISOString() ?? null;
  const evidence = addEvidence(context, {
    id: evidenceId("config-history", resourceType, resourceId, observedAt),
    source: "aws-config",
    kind:
      changedFields.length > 0
        ? "config-change-history"
        : "config-no-change-history",
    label: `${resourceType} 구성 이력 비교`,
    detail:
      changedFields.length > 0
        ? `${resourceId}에서 ${changedFields.length}개 구성 필드 차이를 확인했습니다: ${changedFields
            .slice(0, 8)
            .map((item) => item.path)
            .join(", ")}`
        : `${resourceId}의 조회 기간 내 비교 가능한 구성 변경을 확인하지 못했습니다.`,
    observedAt,
  });
  return {
    evidenceId: evidence.id,
    resourceType,
    resourceId,
    region,
    versions: items.length,
    latestCapturedAt: observedAt,
    previousCapturedAt:
      previous?.configurationItemCaptureTime?.toISOString() ?? null,
    changedFields,
  };
}

export function createAiAuditToolContext(
  config: AwsEnvironmentConfig,
): AiAuditToolContext {
  return {
    config,
    evidence: new Map(),
    limitations: [],
  };
}

export async function executeAiAuditTool(
  context: AiAuditToolContext,
  name: string,
  args: JsonObject,
) {
  try {
    switch (name) {
      case "get_environment_overview":
        return { ok: true, data: await environmentOverview(context) };
      case "get_cost_analysis":
        return { ok: true, data: await costAnalysis(context) };
      case "list_recent_write_events":
        return { ok: true, data: await recentWriteEvents(context, args) };
      case "list_recent_configurations":
        return { ok: true, data: await recentConfigurations(context, args) };
      case "get_resource_history":
        return { ok: true, data: await resourceHistory(context, args) };
      default:
        return { ok: false, error: "Unknown audit tool." };
    }
  } catch (error) {
    const message = safeMessage(error);
    context.limitations.push(`${name}: ${message}`);
    return { ok: false, error: message };
  }
}
