"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type {
  ApiError,
  CommitmentDailyMetric,
  CommitmentMetricSet,
  CostAnomalyReport,
  CostReportResponse,
  CostReportRunResponse,
  EnvironmentId,
  EnvironmentInput,
  EnvironmentReport,
  EnvironmentSummary,
  EnvironmentsResponse,
  MetricValue,
} from "../lib/cloudboard";

const coverageLabels = {
  good: "80% 이상",
  attention: "50–79%",
  risk: "50% 미만",
  unknown: "평가 불가",
};

const metricStatusLabels = {
  ready: "집계 완료",
  pending: "집계 대기",
  unavailable: "데이터 없음",
  error: "조회 실패",
};

const emptyEnvironmentForm: EnvironmentInput = {
  id: "",
  name: "",
  group: "",
  regions: ["ap-northeast-2"],
  credentialRef: "",
};

function formatPercentage(value: number | null) {
  return value === null ? "—" : `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
}

function formatCurrency(value: number | null) {
  return value === null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(value);
}

function formatSignedCurrency(value: number | null) {
  if (value === null) {
    return "—";
  }
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatCurrency(value)}`;
}

function formatSignedPercentage(value: number | null) {
  if (value === null) {
    return "—";
  }
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatAccountId(value: string | null) {
  return value
    ? `${value.slice(0, 4)} ${value.slice(4, 8)} ${value.slice(8)}`
    : "연결 전";
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function inclusiveEndDate(value: string) {
  const end = new Date(`${value}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

function daysUntil(value: string) {
  return Math.max(
    0,
    Math.ceil((new Date(value).getTime() - Date.now()) / 86_400_000),
  );
}

function shortCommitmentId(value: string) {
  return value.length > 22
    ? `${value.slice(0, 10)}…${value.slice(-8)}`
    : value;
}

function utilizationLevel(metric: MetricValue) {
  if (metric.status !== "ready" || metric.value === null) {
    return "unknown";
  }
  if (metric.value >= 80) {
    return "good";
  }
  if (metric.value >= 60) {
    return "attention";
  }
  return "risk";
}

function expiryLevel(end: string | null) {
  if (!end) {
    return "unknown";
  }
  const remaining = daysUntil(end);
  if (remaining <= 30) {
    return "urgent";
  }
  if (remaining <= 90) {
    return "soon";
  }
  return "normal";
}

function metricText(metric: MetricValue, type: "percentage" | "currency") {
  if (metric.status !== "ready") {
    return metricStatusLabels[metric.status];
  }
  return type === "percentage"
    ? formatPercentage(metric.value)
    : formatCurrency(metric.value);
}

function TermWithTooltip({
  label,
  description,
}: {
  label: string;
  description: string;
}) {
  const tooltipId = useId();

  return (
    <span className="term-help">
      <span>{label}</span>
      <button
        className="term-help-trigger"
        type="button"
        aria-label={`${label} 설명`}
        aria-describedby={tooltipId}
      >
        ?
      </button>
      <span className="term-help-content" id={tooltipId} role="tooltip">
        {description}
      </span>
    </span>
  );
}

function MetricSummaryCard({
  title,
  eyebrow,
  coverageDescription,
  utilizationDescription,
  metrics,
}: {
  title: string;
  eyebrow: string;
  coverageDescription: string;
  utilizationDescription: string;
  metrics: CommitmentMetricSet;
}) {
  return (
    <article className={`summary-card metric-summary ${metrics.coverage.status}`}>
      <div className="card-label">
        <TermWithTooltip label={title} description={coverageDescription} />
      </div>
      <div className="metric-heading">
        <strong>{metricText(metrics.coverage, "percentage")}</strong>
        <span>{eyebrow}</span>
      </div>
      {metrics.coverage.status === "ready" && (
        <div className="coverage-track">
          <span
            style={{ width: `${metrics.coverage.value ?? 0}%` }}
            aria-hidden="true"
          />
        </div>
      )}
      <div className="metric-secondary">
        <TermWithTooltip
          label="약정 사용률"
          description={utilizationDescription}
        />
        <strong>{metricText(metrics.utilization, "percentage")}</strong>
      </div>
      {metrics.coverage.message && (
        <p className="metric-message">{metrics.coverage.message}</p>
      )}
    </article>
  );
}

function CostExposureCard({
  label,
  description,
  metric,
  tone,
}: {
  label: string;
  description: string;
  metric: MetricValue;
  tone: "waste" | "opportunity";
}) {
  return (
    <article className={`cost-exposure-card ${tone} ${metric.status}`}>
      <TermWithTooltip label={label} description={description} />
      <strong>{metricText(metric, "currency")}</strong>
      <span>최근 완료 30일</span>
    </article>
  );
}

function CostAnomalyPanel({
  report,
  loading,
  onGenerate,
}: {
  report: CostAnomalyReport | null | undefined;
  loading: boolean;
  onGenerate: () => void;
}) {
  if (!report) {
    return (
      <section className="cost-anomaly-panel empty" id="daily-cost">
        <div>
          <span className="section-index">DAILY COST CHECK</span>
          <h2>일일 비용 이상 리포트</h2>
          <p>
            집계 완료된 최신 AWS 비용을 최근 동일 요일과 비교합니다.
          </p>
        </div>
        <button type="button" onClick={onGenerate} disabled={loading}>
          {loading ? "분석 중…" : "지금 분석"}
        </button>
      </section>
    );
  }

  const statusLabel = {
    anomaly: "비용 증가 감지",
    normal: "정상 범위",
    "insufficient-data": "비교 데이터 부족",
  }[report.status];

  return (
    <section
      className={`cost-anomaly-panel ${report.status}`}
      id="daily-cost"
      aria-labelledby="daily-cost-title"
    >
      <div className="cost-anomaly-heading">
        <div>
          <span className="section-index">DAILY COST CHECK / AWS UTC</span>
          <h2 id="daily-cost-title">일일 비용 이상 리포트</h2>
        </div>
        <div className="cost-anomaly-actions">
          <span className={`cost-anomaly-status ${report.status}`}>
            {statusLabel}
          </span>
          <button type="button" onClick={onGenerate} disabled={loading}>
            {loading ? "분석 중…" : "다시 분석"}
          </button>
        </div>
      </div>

      <div className="cost-anomaly-summary">
        <div className="cost-anomaly-primary">
          <span>
            최신 완료 UTC 일자 · {report.basisDate}
            {report.costIsEstimated ? " · 당월 잠정치" : ""}
          </span>
          <strong>{formatCurrency(report.totalCostUsd)}</strong>
          <small>
            AWS UTC 기준 D-{report.freshnessDays} · Net Amortized Cost
          </small>
        </div>
        <div>
          <TermWithTooltip
            label="최근 동일 요일 중앙값"
            description="기준일과 같은 요일인 최근 4주 비용의 중앙값입니다. 특정 하루의 급등락에 평균보다 덜 흔들립니다."
          />
          <strong>{formatCurrency(report.weekdayMedianUsd)}</strong>
          <span>
            {formatSignedCurrency(report.weekdayChangeUsd)} ·{" "}
            {formatSignedPercentage(report.weekdayChangePercentage)}
          </span>
        </div>
        <div>
          <TermWithTooltip
            label="직전 비용일"
            description="최신 완료 UTC 일자의 바로 이전 비용 일자입니다. 전일 추세 확인용이며 이상 판정의 주 기준은 동일 요일 중앙값입니다."
          />
          <strong>{formatCurrency(report.previousFinalizedCostUsd)}</strong>
          <span>
            {formatSignedCurrency(report.previousDayChangeUsd)} ·{" "}
            {formatSignedPercentage(report.previousDayChangePercentage)}
          </span>
        </div>
      </div>

      <p className="cost-anomaly-message">
        {report.message} 이상 판정 기준은 동일 요일 중앙값 대비{" "}
        {report.thresholds.relativePercentage}% 이상이면서{" "}
        {formatCurrency(report.thresholds.absoluteUsd)} 이상 증가입니다.
      </p>

      {report.topDrivers.length > 0 && (
        <div className="cost-driver-list">
          <div className="cost-driver-row table-head">
            <span>비용 변동 서비스</span>
            <span>기준일 비용</span>
            <span>동일 요일 대비</span>
          </div>
          {report.topDrivers.map((driver) => (
            <div className="cost-driver-row" key={driver.service}>
              <strong>{driver.service}</strong>
              <span>{formatCurrency(driver.costUsd)}</span>
              <span
                className={
                  driver.changeUsd !== null && driver.changeUsd > 0
                    ? "increase"
                    : "decrease"
                }
              >
                {formatSignedCurrency(driver.changeUsd)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function TrendChart({
  title,
  description,
  data,
}: {
  title: string;
  description: string;
  data: CommitmentDailyMetric[];
}) {
  const width = 640;
  const height = 190;
  const padding = { top: 18, right: 18, bottom: 28, left: 38 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const x = (index: number) =>
    padding.left +
    (data.length <= 1 ? plotWidth / 2 : (index / (data.length - 1)) * plotWidth);
  const y = (value: number) =>
    padding.top + ((100 - value) / 100) * plotHeight;
  const pathFor = (
    value: (point: CommitmentDailyMetric) => number | null,
  ) => {
    let started = false;
    return data
      .map((point, index) => {
        const current = value(point);
        if (current === null) {
          started = false;
          return null;
        }
        const command = started ? "L" : "M";
        started = true;
        return `${command} ${x(index).toFixed(1)} ${y(current).toFixed(1)}`;
      })
      .filter((segment): segment is string => Boolean(segment))
      .join(" ");
  };

  return (
    <article className="trend-card">
      <header>
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <div className="trend-legend" aria-label="그래프 범례">
          <span className="coverage">할인 적용률</span>
          <span className="utilization">약정 사용률</span>
        </div>
      </header>
      {data.length > 0 ? (
        <>
          <svg
            className="trend-chart"
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`${title}의 최근 30일 할인 적용률과 약정 사용률 추세`}
          >
            {[0, 25, 50, 75, 100].map((value) => (
              <g key={value}>
                <line
                  x1={padding.left}
                  x2={width - padding.right}
                  y1={y(value)}
                  y2={y(value)}
                  className="trend-grid-line"
                />
                <text x={4} y={y(value) + 3} className="trend-axis-label">
                  {value}%
                </text>
              </g>
            ))}
            <path className="trend-line coverage" d={pathFor((point) => point.coveragePercentage)} />
            <path
              className="trend-line utilization"
              d={pathFor((point) => point.utilizationPercentage)}
            />
            {data.map((point, index) => (
              <g key={point.date}>
                {point.coveragePercentage !== null && (
                  <circle
                    className="trend-point coverage"
                    cx={x(index)}
                    cy={y(point.coveragePercentage)}
                    r="2.5"
                  >
                    <title>
                      {point.date} 할인 적용률 {point.coveragePercentage}%
                    </title>
                  </circle>
                )}
                {point.utilizationPercentage !== null && (
                  <circle
                    className="trend-point utilization"
                    cx={x(index)}
                    cy={y(point.utilizationPercentage)}
                    r="2.5"
                  >
                    <title>
                      {point.date} 약정 사용률 {point.utilizationPercentage}%
                    </title>
                  </circle>
                )}
              </g>
            ))}
            <text
              x={padding.left}
              y={height - 6}
              className="trend-date-label"
            >
              {data[0]?.date.slice(5)}
            </text>
            <text
              x={width - padding.right}
              y={height - 6}
              textAnchor="end"
              className="trend-date-label"
            >
              {data.at(-1)?.date.slice(5)}
            </text>
          </svg>
          <table className="sr-only">
            <caption>{title} 일별 지표</caption>
            <thead>
              <tr>
                <th>날짜</th>
                <th>할인 적용률</th>
                <th>약정 사용률</th>
              </tr>
            </thead>
            <tbody>
              {data.map((point) => (
                <tr key={point.date}>
                  <td>{point.date}</td>
                  <td>{formatPercentage(point.coveragePercentage)}</td>
                  <td>{formatPercentage(point.utilizationPercentage)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="trend-table-summary">
            일별 정확한 값은 그래프의 각 점에 마우스를 올려 확인할 수 있습니다.
          </p>
        </>
      ) : (
        <div className="trend-empty">
          일별 추세를 만들 수 있는 비용 데이터가 없습니다.
        </div>
      )}
    </article>
  );
}

function LoadingState() {
  return (
    <div className="loading-grid" aria-live="polite" aria-busy="true">
      <span className="sr-only">AWS 자원을 조회하고 있습니다.</span>
      {Array.from({ length: 8 }, (_, index) => (
        <div className="loading-block" key={index} />
      ))}
    </div>
  );
}

function EmptyState({
  credentialRef,
  message,
}: {
  credentialRef: string;
  message: string;
}) {
  return (
    <section className="empty-state">
      <span className="empty-eyebrow">환경 설정 필요</span>
      <h2>{message}</h2>
      <p>
        읽기 전용 AWS 자격 증명 CSV를 아래 파일명으로 Secret volume에
        마운트하세요. 키 파일은 SQLite, 이미지, Git에 저장하지 않습니다.
      </p>
      <div className="config-keys">
        <code>{credentialRef}.csv</code>
      </div>
    </section>
  );
}

function NoEnvironmentsState() {
  return (
    <section className="empty-state">
      <span className="empty-eyebrow">환경 설정 필요</span>
      <h2>등록된 AWS 환경이 없습니다.</h2>
      <p>
        <code>config/environments.json</code>에 환경을 추가하고 읽기 전용 자격
        증명 파일을 Secret 경로로 연결하세요.
      </p>
    </section>
  );
}

function EnvironmentManager({
  environments,
  token,
  onClose,
  onChanged,
}: {
  environments: EnvironmentSummary[];
  token: string;
  onClose: () => void;
  onChanged: (preferredEnvironmentId?: string, deletedId?: string) => void;
}) {
  const [form, setForm] = useState(emptyEnvironmentForm);
  const [saving, setSaving] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();

    return () => previouslyFocused?.focus();
  }, []);

  const headers = {
    "Content-Type": "application/json",
    ...(token ? { "x-cloudboard-token": token } : {}),
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMutationError(null);
    try {
      const response = await fetch("/api/environments", {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...form,
          regions: form.regions[0]
            .split(",")
            .map((region) => region.trim())
            .filter(Boolean),
          credentialRef: form.credentialRef || form.id.replaceAll("-", "_"),
        }),
      });
      const body = (await response.json()) as EnvironmentSummary | ApiError;
      if (!response.ok || !("id" in body)) {
        throw new Error(
          "error" in body ? body.error : "환경을 추가하지 못했습니다.",
        );
      }
      setForm(emptyEnvironmentForm);
      onChanged(body.id);
    } catch (error) {
      setMutationError(
        error instanceof Error ? error.message : "환경을 추가하지 못했습니다.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(environment: EnvironmentSummary) {
    if (
      !window.confirm(
        `${environment.name} (${environment.id}) 환경을 삭제할까요?\nAWS 자격 증명 파일과 비용 데이터는 삭제되지 않습니다.`,
      )
    ) {
      return;
    }

    setSaving(true);
    setMutationError(null);
    try {
      const response = await fetch(
        `/api/environments/${encodeURIComponent(environment.id)}`,
        {
          method: "DELETE",
          headers: token ? { "x-cloudboard-token": token } : {},
        },
      );
      if (!response.ok) {
        const body = (await response.json()) as ApiError;
        throw new Error(body.error);
      }
      onChanged(undefined, environment.id);
    } catch (error) {
      setMutationError(
        error instanceof Error ? error.message : "환경을 삭제하지 못했습니다.",
      );
    } finally {
      setSaving(false);
    }
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const focusableElements = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.getClientRects().length > 0);
    const firstElement = focusableElements[0];
    const lastElement = focusableElements.at(-1);

    if (
      event.shiftKey &&
      document.activeElement === firstElement &&
      lastElement
    ) {
      event.preventDefault();
      lastElement.focus();
    } else if (
      !event.shiftKey &&
      document.activeElement === lastElement &&
      firstElement
    ) {
      event.preventDefault();
      firstElement.focus();
    }
  }

  return (
    <div className="manager-backdrop" role="presentation">
      <section
        className="environment-manager"
        role="dialog"
        aria-modal="true"
        aria-labelledby="environment-manager-title"
        onKeyDown={handleDialogKeyDown}
      >
        <header className="manager-heading">
          <div>
            <span className="section-index">AWS ENVIRONMENTS</span>
            <h2 id="environment-manager-title">AWS 환경 관리</h2>
          </div>
          <button
            ref={closeButtonRef}
            className="manager-close"
            type="button"
            onClick={onClose}
            aria-label="환경 관리 닫기"
          >
            ×
          </button>
        </header>

        <div className="managed-environment-list">
          {environments.map((environment) => (
            <div className="managed-environment" key={environment.id}>
              <span
                className={`status-indicator ${
                  environment.configured ? "ready" : "unconfigured"
                }`}
              />
              <div>
                <strong>{environment.name}</strong>
                <span>
                  {environment.group} · {environment.id} ·{" "}
                  {environment.regions.join(", ")}
                </span>
                <small>
                  Secret: {environment.credentialRef}.csv ·{" "}
                  {environment.configured ? "연결됨" : "파일 없음"}
                </small>
              </div>
              <button
                type="button"
                onClick={() => void handleDelete(environment)}
                disabled={saving}
              >
                삭제
              </button>
            </div>
          ))}
          {environments.length === 0 && (
            <p className="manager-empty">등록된 환경이 없습니다.</p>
          )}
        </div>

        <form className="environment-form" onSubmit={handleSubmit}>
          <div className="form-heading">
            <strong>새 환경 추가</strong>
            <span>
              AWS 키 값은 저장하지 않고, 서버에 마운트된 자격 증명 파일명만
              등록합니다.
            </span>
          </div>
          <label>
            <span>환경 ID</span>
            <input
              required
              value={form.id}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  id: event.target.value.toLowerCase(),
                }))
              }
              placeholder="b2b-dev"
              pattern="[a-z0-9](?:[a-z0-9]|-){0,62}"
            />
          </label>
          <label>
            <span>표시 이름</span>
            <input
              required
              value={form.name}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
              placeholder="B2B Development"
              maxLength={80}
            />
          </label>
          <label>
            <span>그룹</span>
            <input
              required
              value={form.group}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  group: event.target.value,
                }))
              }
              placeholder="B2B"
              maxLength={40}
            />
          </label>
          <label>
            <span>AWS 리전</span>
            <input
              required
              value={form.regions[0]}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  regions: [event.target.value],
                }))
              }
              placeholder="ap-northeast-2, us-east-1"
            />
          </label>
          <label className="credential-reference">
            <span>Secret 파일명</span>
            <div>
              <input
                value={form.credentialRef}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    credentialRef: event.target.value.toLowerCase(),
                  }))
                }
                placeholder="환경 ID에서 자동 생성"
                pattern="[a-z0-9](?:[a-z0-9_]|-){0,63}"
              />
              <span>.csv</span>
            </div>
            <small>
              확장자(.csv)를 제외한 이름입니다. 로컬에서는 credentials 폴더,
              배포 환경에서는 읽기 전용 Secret volume에서 찾습니다.
            </small>
          </label>
          {mutationError && (
            <p className="manager-error" role="alert">
              {mutationError}
            </p>
          )}
          <button className="add-environment-button" type="submit" disabled={saving}>
            {saving ? "저장 중…" : "환경 추가"}
          </button>
        </form>
      </section>
    </div>
  );
}

export function CloudBoardDashboard() {
  const [environments, setEnvironments] = useState<EnvironmentSummary[]>([]);
  const [environment, setEnvironment] = useState<EnvironmentId | null>(null);
  const [reports, setReports] = useState<
    Partial<Record<EnvironmentId, EnvironmentReport>>
  >({});
  const [costReports, setCostReports] = useState<
    Partial<Record<EnvironmentId, CostAnomalyReport | null>>
  >({});
  const [environmentListLoading, setEnvironmentListLoading] = useState(true);
  const [loading, setLoading] = useState<EnvironmentId | null>(null);
  const [costReportLoading, setCostReportLoading] =
    useState<EnvironmentId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [token, setToken] = useState(() =>
    typeof window === "undefined"
      ? ""
      : (sessionStorage.getItem("cloudboard-access-token") ?? ""),
  );

  const loadEnvironments = useCallback(async (preferredEnvironmentId?: string) => {
    setEnvironmentListLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/environments", {
        headers: token ? { "x-cloudboard-token": token } : {},
        cache: "no-store",
      });
      const body = (await response.json()) as EnvironmentsResponse | ApiError;
      if (!response.ok) {
        throw new Error(
          "error" in body ? body.error : "환경 목록 조회에 실패했습니다.",
        );
      }
      if (!("environments" in body)) {
        throw new Error("환경 목록 조회에 실패했습니다.");
      }
      setEnvironments(body.environments);
      setEnvironment((current) =>
        preferredEnvironmentId &&
        body.environments.some(
          (environmentItem) => environmentItem.id === preferredEnvironmentId,
        )
          ? preferredEnvironmentId
          : current &&
              body.environments.some(
                (environmentItem) => environmentItem.id === current,
              )
            ? current
            : (body.environments[0]?.id ?? null),
      );
    } catch (loadError) {
      setEnvironments([]);
      setEnvironment(null);
      setError(
        loadError instanceof Error
          ? loadError.message
          : "환경 목록 조회에 실패했습니다.",
      );
    } finally {
      setEnvironmentListLoading(false);
    }
  }, [token]);

  const loadReport = useCallback(
    async (environmentId: EnvironmentId, refresh = false) => {
      setLoading(environmentId);
      setError(null);
      try {
        const query = new URLSearchParams({
          environment: environmentId,
          ...(refresh ? { refresh: "true" } : {}),
        });
        const response = await fetch(`/api/coverage?${query}`, {
          headers: token ? { "x-cloudboard-token": token } : {},
          cache: "no-store",
        });
        const body = (await response.json()) as EnvironmentReport | ApiError;
        if (!response.ok) {
          if ("code" in body && body.code === "INVALID_ENVIRONMENT") {
            await loadEnvironments();
            return;
          }
          throw new Error(body.error ?? "조회에 실패했습니다.");
        }
        setReports((current) => ({
          ...current,
          [environmentId]: body as EnvironmentReport,
        }));
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "조회에 실패했습니다.",
        );
      } finally {
        setLoading(null);
      }
    },
    [loadEnvironments, token],
  );

  const loadCostReport = useCallback(
    async (environmentId: EnvironmentId, generate = false) => {
      setCostReportLoading(environmentId);
      try {
        const query = new URLSearchParams({ environment: environmentId });
        const response = await fetch(`/api/reports/daily-cost?${query}`, {
          method: generate ? "POST" : "GET",
          headers: token ? { "x-cloudboard-token": token } : {},
          cache: "no-store",
        });
        const body = (await response.json()) as
          | CostReportResponse
          | CostReportRunResponse
          | ApiError;
        if (!response.ok) {
          throw new Error(
            "error" in body
              ? body.error
              : "일일 비용 리포트를 불러오지 못했습니다.",
          );
        }
        const nextReport =
          "reports" in body
            ? (body.reports.find(
                (item) => item.environmentId === environmentId,
              ) ?? null)
            : "report" in body
              ? body.report
              : null;
        setCostReports((current) => ({
          ...current,
          [environmentId]: nextReport,
        }));
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "일일 비용 리포트를 불러오지 못했습니다.",
        );
      } finally {
        setCostReportLoading(null);
      }
    },
    [token],
  );

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadEnvironments();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadEnvironments]);

  useEffect(() => {
    if (environment && !reports[environment]) {
      const timeoutId = window.setTimeout(() => {
        void loadReport(environment);
      }, 0);
      return () => window.clearTimeout(timeoutId);
    }
  }, [environment, loadReport, reports]);

  useEffect(() => {
    if (environment && !(environment in costReports)) {
      const timeoutId = window.setTimeout(() => {
        void loadCostReport(environment);
      }, 0);
      return () => window.clearTimeout(timeoutId);
    }
  }, [costReports, environment, loadCostReport]);

  const report = environment ? reports[environment] : undefined;
  const selectedEnvironment = environments.find(
    (item) => item.id === environment,
  );
  const summary = useMemo(() => {
    if (!report) {
      return null;
    }

    const commitments = [
      ...report.reservations.map((reservation) => ({
        id: `ri-${reservation.service}-${reservation.region}-${reservation.id}`,
        kind: "RI",
        title: reservation.service,
        detail: `${reservation.family} · ${reservation.region}`,
        reference: reservation.id,
        commitment: `${reservation.quantity}개 RI`,
        utilization: reservation.utilization,
        end: reservation.end,
      })),
      ...report.savingsPlans.map((plan) => ({
        id: `sp-${plan.id}`,
        kind: "SP",
        title: `${plan.type} Savings Plan`,
        detail: plan.region ?? "Global",
        reference: plan.id,
        commitment: `$${plan.hourlyCommitment.toFixed(2)} / 시간`,
        utilization: plan.utilization,
        end: plan.end,
      })),
    ].sort((left, right) => (left.end ?? "").localeCompare(right.end ?? ""));

    const savingsMetrics = [
      report.metrics.ri.netSavingsUsd,
      report.metrics.savingsPlans.netSavingsUsd,
    ];
    const readySavings = savingsMetrics
      .filter((metric) => metric.status === "ready")
      .map((metric) => metric.value)
      .filter((value): value is number => value !== null);

    return {
      commitments,
      nextExpiry:
        commitments.find((commitment) => commitment.end !== null) ?? null,
      totalSavings:
        readySavings.length > 0
          ? readySavings.reduce((sum, value) => sum + value, 0)
          : null,
      savingsIncomplete: savingsMetrics.some(
        (metric) => metric.status !== "ready",
      ),
      activeRi: report.reservations.reduce(
        (sum, reservation) => sum + reservation.quantity,
        0,
      ),
      risks: report.findings.filter(
        (finding) => finding.severity === "high",
      ).length,
    };
  }, [report]);

  const handleTokenChange = (value: string) => {
    setToken(value);
    if (value) {
      sessionStorage.setItem("cloudboard-access-token", value);
    } else {
      sessionStorage.removeItem("cloudboard-access-token");
    }
  };

  const handleEnvironmentsChanged = (
    preferredEnvironmentId?: string,
    deletedId?: string,
  ) => {
    if (deletedId) {
      setEnvironment((current) => (current === deletedId ? null : current));
      setError(null);
      setReports((current) => {
        const next = { ...current };
        delete next[deletedId];
        return next;
      });
      setCostReports((current) => {
        const next = { ...current };
        delete next[deletedId];
        return next;
      });
    }
    void loadEnvironments(preferredEnvironmentId);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">C</span>
          <div>
            <strong>CloudBoard</strong>
            <span>RI·SP 비용 관리</span>
          </div>
        </div>

        <nav className="primary-nav" aria-label="주요 메뉴">
          <a className="nav-item active" href="#commitments" aria-current="page">
            <span>01</span>
            활성 약정
          </a>
          <a className="nav-item" href="#overview">
            <span>02</span>
            비용·효율
          </a>
          <a className="nav-item" href="#services">
            <span>03</span>
            서비스별 적용
          </a>
        </nav>

        <div className="sidebar-footer">
          <span className="security-dot" />
          <div>
            <strong>AWS 읽기 전용 연결</strong>
            <span>자격 증명은 서버에서만 사용</span>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <p className="eyebrow">AWS 비용·약정 관리</p>
            <h1>RI·Savings Plans 운영 현황</h1>
          </div>
          <div className="topbar-actions">
            <label className="token-field">
              <span>대시보드 접근 토큰</span>
              <input
                type="password"
                value={token}
                onChange={(event) => handleTokenChange(event.target.value)}
                placeholder="서버에 설정된 경우 입력"
                autoComplete="current-password"
              />
            </label>
            <button
              className="manage-environments-button"
              type="button"
              onClick={() => setManagerOpen(true)}
            >
              환경 관리
            </button>
            <button
              className="refresh-button"
              type="button"
              onClick={() => {
                void loadEnvironments();
                if (environment) {
                  void loadReport(environment, true);
                  void loadCostReport(environment);
                }
              }}
              disabled={loading !== null || environmentListLoading}
            >
              <span
                className={
                  loading || environmentListLoading
                    ? "refresh-icon spinning"
                    : "refresh-icon"
                }
              >
                ↻
              </span>
              새로고침
            </button>
          </div>
        </header>

        <section className="environment-bar" aria-label="AWS 환경 선택">
          <div className="environment-tabs">
            {environments.map((item) => (
              <button
                key={item.id}
                type="button"
                className={[
                  environment === item.id ? "selected" : "",
                  item.configured ? "" : "unconfigured",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => setEnvironment(item.id)}
              >
                <span>
                  {item.group} · {item.id.toUpperCase()}
                </span>
                {item.name}
              </button>
            ))}
          </div>
          <div className="environment-meta">
            <span
              className={`status-indicator ${report?.status ?? "loading"}`}
            />
            <span>
              {report
                ? formatAccountId(report.accountId)
                : environmentListLoading
                  ? "환경 조회 중"
                  : environment
                    ? "연결 중"
                    : "환경 없음"}
            </span>
            {report && report.regions.length > 0 && (
              <>
                <span className="divider" />
                <span>{report.regions.join(", ")}</span>
              </>
            )}
          </div>
        </section>

        {error && (
          <div className="error-banner" role="alert">
            <div>
              <strong>데이터를 불러오지 못했습니다</strong>
              <span>{error}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                void loadEnvironments();
                if (environment) {
                  void loadReport(environment);
                }
              }}
            >
              다시 시도
            </button>
          </div>
        )}

        {environmentListLoading ? (
          <LoadingState />
        ) : !environment && environments.length === 0 ? (
          <NoEnvironmentsState />
        ) : loading === environment && !report ? (
          <LoadingState />
        ) : report?.status === "unconfigured" ? (
          <EmptyState
            credentialRef={selectedEnvironment?.credentialRef ?? report.id}
            message={report.error ?? "AWS 환경 설정이 필요합니다."}
          />
        ) : report?.status === "failed" ? (
          <EmptyState
            credentialRef={selectedEnvironment?.credentialRef ?? report.id}
            message={report.error ?? "AWS 연결을 확인해 주세요."}
          />
        ) : report && summary ? (
          <>
            <section
              className="commitment-portfolio"
              id="commitments"
              aria-labelledby="active-commitments-title"
            >
              <div className="commitment-portfolio-heading">
                <div>
                  <span className="section-index">ACTIVE COMMITMENTS</span>
                  <h2 id="active-commitments-title">현재 사용 중인 RI·Savings Plans</h2>
                  <p>
                    보유 약정별 최근 30일 사용률과 만료일입니다. 사용률이 낮거나
                    만료가 가까운 약정부터 확인하세요.
                  </p>
                </div>
                <div className="portfolio-counts" aria-label="활성 약정 요약">
                  <span>
                    활성 약정 <strong>{summary.commitments.length}</strong>
                  </span>
                  <span>
                    RI 수량 <strong>{summary.activeRi}</strong>
                  </span>
                  <span>
                    SP 계약 <strong>{report.savingsPlans.length}</strong>
                  </span>
                </div>
              </div>

              {summary.commitments.length > 0 ? (
                <div className="commitment-table" role="table">
                  <div className="commitment-table-row table-head" role="row">
                    <span role="columnheader">구분</span>
                    <span role="columnheader">활성 약정</span>
                    <span role="columnheader">약정 규모</span>
                    <span role="columnheader">
                      <TermWithTooltip
                        label="최근 30일 사용률"
                        description="RI는 구매한 예약 시간 중 실제 워크로드에 적용된 비율, SP는 구매한 약정액 중 할인 대상 사용량에 적용된 비율입니다. 할인 적용률(Coverage)과는 다른 지표입니다."
                      />
                    </span>
                    <span role="columnheader">만료일</span>
                  </div>

                  {summary.commitments.map((commitment) => {
                    const usageLevel = utilizationLevel(
                      commitment.utilization,
                    );
                    const remainingDays = commitment.end
                      ? daysUntil(commitment.end)
                      : null;

                    return (
                      <div
                        className="commitment-table-row"
                        role="row"
                        key={commitment.id}
                      >
                        <span role="cell">
                          <span
                            className={`commitment-kind ${commitment.kind.toLowerCase()}`}
                          >
                            {commitment.kind}
                          </span>
                        </span>
                        <span className="commitment-identity" role="cell">
                          <strong>{commitment.title}</strong>
                          <span>{commitment.detail}</span>
                          <code title={commitment.reference}>
                            {shortCommitmentId(commitment.reference)}
                          </code>
                        </span>
                        <span className="commitment-size" role="cell">
                          {commitment.commitment}
                        </span>
                        <span
                          className={`commitment-utilization ${usageLevel}`}
                          role="cell"
                          title={
                            commitment.utilization.message ??
                            "최근 완료 30일 기준 약정 사용률"
                          }
                        >
                          <span className="utilization-value">
                            <strong>
                              {metricText(
                                commitment.utilization,
                                "percentage",
                              )}
                            </strong>
                            <small>
                              {commitment.utilization.status === "ready"
                                ? "최근 완료 30일"
                                : commitment.utilization.message}
                            </small>
                          </span>
                          {commitment.utilization.status === "ready" &&
                            commitment.utilization.value !== null && (
                              <span
                                className="utilization-track"
                                aria-hidden="true"
                              >
                                <span
                                  style={{
                                    width: `${commitment.utilization.value}%`,
                                  }}
                                />
                              </span>
                            )}
                        </span>
                        <span className="commitment-expiry" role="cell">
                          <strong>
                            {commitment.end
                              ? formatDate(commitment.end)
                              : "종료일 없음"}
                          </strong>
                          <span
                            className={`expiry-status ${expiryLevel(
                              commitment.end,
                            )}`}
                          >
                            {remainingDays === null
                              ? "확인 필요"
                              : remainingDays === 0
                                ? "오늘 만료"
                                : `D-${remainingDays}`}
                          </span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="no-commitments">
                  <span>RI</span>
                  <strong>현재 활성화된 RI 또는 Savings Plan이 없습니다</strong>
                  <p>
                    안정적으로 유지되는 사용량을 확인한 뒤 신규 약정 구매를
                    검토하세요.
                  </p>
                </div>
              )}
            </section>

            <CostAnomalyPanel
              report={environment ? costReports[environment] : undefined}
              loading={costReportLoading === environment}
              onGenerate={() => {
                if (environment) {
                  void loadCostReport(environment, true);
                }
              }}
            />

            <section className="metric-guide" id="overview">
              <div>
                <strong>할인 적용률(Coverage)</strong>
                <span>전체 할인 대상 사용량 중 RI 또는 SP가 적용된 비율</span>
              </div>
              <span className="guide-divider" />
              <div>
                <strong>약정 사용률(Utilization)</strong>
                <span>구매한 RI 또는 SP 약정 중 실제 사용량에 적용된 비율</span>
              </div>
              <p>
                최근 30개의 완료된 UTC 일자를 기준으로 하며, 두 비율은 서로
                다른 대상을 측정합니다.
              </p>
            </section>

            <section className="summary-grid">
              <MetricSummaryCard
                title="RI 할인 적용률"
                eyebrow="최근 완료 30일"
                coverageDescription="RI 적용 시간 ÷ 전체 RI 할인 대상 시간입니다. 실행 자원 수나 보유 RI 수를 단순 비교한 값이 아닙니다."
                utilizationDescription="구매한 RI 시간 중 실제 사용량에 적용된 시간의 비율입니다. 낮으면 사용하지 못한 RI 비용이 발생할 수 있습니다."
                metrics={report.metrics.ri}
              />
              <MetricSummaryCard
                title="SP 할인 적용률"
                eyebrow="최근 완료 30일"
                coverageDescription="Savings Plans가 적용된 On-Demand 환산 비용 ÷ 전체 SP 할인 대상 비용입니다."
                utilizationDescription="구매한 Savings Plans 약정액 중 실제 할인 대상 사용량에 적용된 비율입니다. 낮으면 미사용 약정액이 발생합니다."
                metrics={report.metrics.savingsPlans}
              />
              <article className="summary-card featured savings-summary">
                <div className="card-label">
                  <TermWithTooltip
                    label="최근 30일 추정 순절감액"
                    description="동일 사용량을 On-Demand 요금으로 사용했을 때의 추정 비용에서 RI·SP 약정 비용을 뺀 금액입니다. AWS Cost Explorer의 Net Savings를 사용합니다."
                  />
                </div>
                <div className="coverage-value">
                  {formatCurrency(summary.totalSavings)}
                </div>
                <div className="savings-split">
                  <span>
                    RI
                    <strong>
                      {metricText(
                        report.metrics.ri.netSavingsUsd,
                        "currency",
                      )}
                    </strong>
                  </span>
                  <span>
                    SP
                    <strong>
                      {metricText(
                        report.metrics.savingsPlans.netSavingsUsd,
                        "currency",
                      )}
                    </strong>
                  </span>
                </div>
                <p>
                  {summary.savingsIncomplete
                    ? "일부 비용 데이터는 집계 대기 또는 조회 불가 상태입니다."
                    : "동일 사용량의 On-Demand 환산 비용과 비교한 추정 절감액"}
                </p>
              </article>
              <article className="summary-card expiry-summary">
                <div className="card-label">
                  <TermWithTooltip
                    label="가장 먼저 만료되는 약정"
                    description="현재 활성 상태인 RI와 Savings Plans 중 종료일이 가장 가까운 약정입니다. D-0은 오늘 만료를 뜻합니다."
                  />
                </div>
                {summary.nextExpiry?.end ? (
                  <>
                    <strong>D-{daysUntil(summary.nextExpiry.end)}</strong>
                    <p>{summary.nextExpiry.title}</p>
                    <span className="expiry-date">
                      {formatDate(summary.nextExpiry.end)}
                    </span>
                  </>
                ) : (
                  <>
                    <strong>—</strong>
                    <p>활성 RI 또는 Savings Plan이 없습니다.</p>
                  </>
                )}
                <div className="active-counts">
                  <span>활성 RI 수량 {summary.activeRi}</span>
                  <span>활성 SP 계약 {report.savingsPlans.length}건</span>
                </div>
              </article>
            </section>

            <section
              className="cost-exposure-section"
              aria-labelledby="cost-exposure-title"
            >
              <div className="section-heading-inline">
                <div>
                  <span className="section-index">COST IMPACT / 30 DAYS</span>
                  <h2 id="cost-exposure-title">약정 낭비와 추가 절감 기회</h2>
                </div>
                <p>
                  같은 비용을 중복 합산하지 않고 RI와 SP를 각각 표시합니다.
                </p>
              </div>
              <div className="cost-exposure-grid">
                <CostExposureCard
                  label="사용하지 못한 RI 비용"
                  description="구매한 RI 시간 중 실제 사용량에 적용되지 않은 시간의 약정 비용입니다. Cost Explorer의 RI Cost For Unused Hours 기준입니다."
                  metric={report.metrics.ri.unusedCommitmentUsd}
                  tone="waste"
                />
                <CostExposureCard
                  label="사용하지 못한 SP 약정액"
                  description="구매한 Savings Plans 약정액 중 할인 대상 사용량에 적용되지 않은 금액입니다. Cost Explorer의 Unused Commitment 기준입니다."
                  metric={report.metrics.savingsPlans.unusedCommitmentUsd}
                  tone="waste"
                />
                <CostExposureCard
                  label="RI 미적용 On-Demand 비용"
                  description="RI 할인 대상 사용량 중 RI가 적용되지 않은 시간의 On-Demand 비용입니다. SP 적용 범위와 겹칠 수 있어 SP 미적용 비용과 합산하지 않습니다."
                  metric={report.metrics.ri.uncoveredOnDemandUsd}
                  tone="opportunity"
                />
                <CostExposureCard
                  label="SP 미적용 할인 대상 비용"
                  description="RI 또는 Savings Plans가 적용되지 않아 On-Demand로 청구된 SP 할인 대상 비용입니다."
                  metric={report.metrics.savingsPlans.uncoveredOnDemandUsd}
                  tone="opportunity"
                />
              </div>
            </section>

            <section
              className="trend-section"
              aria-labelledby="commitment-trend-title"
            >
              <div className="section-heading-inline">
                <div>
                  <span className="section-index">DAILY TREND / 30 DAYS</span>
                  <h2 id="commitment-trend-title">일별 할인 적용·약정 사용 추세</h2>
                </div>
                <p>평균값에 가려진 최근 악화와 일시적인 변동을 확인합니다.</p>
              </div>
              <div className="trend-grid">
                <TrendChart
                  title="Reserved Instances"
                  description="RI 적용 시간과 구매 시간의 일별 변화"
                  data={report.metrics.ri.daily}
                />
                <TrendChart
                  title="Savings Plans"
                  description="SP 적용 비용과 시간당 약정 사용의 일별 변화"
                  data={report.metrics.savingsPlans.daily}
                />
              </div>
            </section>

            <section className="panel service-panel" id="services">
              <div className="panel-heading">
                <div>
                  <span className="section-index">01 / RI DISCOUNT COVERAGE</span>
                  <h2>서비스별 RI 할인 적용률</h2>
                </div>
                <span className="updated-at">
                  {report.coverageWindow.start} —{" "}
                  {inclusiveEndDate(report.coverageWindow.end)}
                </span>
              </div>

              <div className="service-table" role="table">
                <div className="service-row table-head" role="row">
                  <span role="columnheader">서비스</span>
                  <span role="columnheader">
                    <TermWithTooltip
                      label="실행 자원 / 보유 RI"
                      description="현재 실행 중인 자원 수와 활성 RI 수량입니다. 인스턴스 크기와 RI 유연성이 달라 두 숫자의 단순 비교로 할인 적용률을 계산할 수 없습니다."
                    />
                  </span>
                  <span role="columnheader">
                    <TermWithTooltip
                      label="RI 할인 적용률"
                      description="최근 완료 30일 동안 전체 RI 할인 대상 시간 중 RI가 적용된 시간의 비율입니다."
                    />
                  </span>
                  <span role="columnheader">다음 RI 만료</span>
                  <span role="columnheader">
                    <TermWithTooltip
                      label="적용률 구간"
                      description="RI 할인 적용률을 80% 이상, 50~79%, 50% 미만으로 구분합니다. 실행 자원이 없거나 값을 조회하지 못하면 평가 불가로 표시합니다."
                    />
                  </span>
                </div>
                {report.services.map((service) => {
                  const nextServiceExpiry = report.reservations
                    .filter(
                      (reservation) =>
                        reservation.service === service.name && reservation.end,
                    )
                    .sort((a, b) =>
                      (a.end ?? "").localeCompare(b.end ?? ""),
                    )[0];

                  return (
                    <details className="service-details" key={service.key}>
                      <summary className="service-row" role="row">
                        <span className="service-name" role="cell">
                          <span className={`service-monogram ${service.key}`}>
                            {service.name
                              .replace("Amazon ", "")
                              .slice(0, 2)
                              .toUpperCase()}
                          </span>
                          <span>
                            <strong>{service.name}</strong>
                            <small>
                              리전·패밀리 조합 {service.breakdown.length}개
                            </small>
                          </span>
                        </span>
                        <span className="resource-count" role="cell">
                          <strong>{service.running}</strong>
                          <small>/ {service.reserved}</small>
                        </span>
                        <span role="cell">
                          {formatPercentage(service.riCoveragePercentage)}
                        </span>
                        <span role="cell">
                          {nextServiceExpiry?.end
                            ? `D-${daysUntil(nextServiceExpiry.end)}`
                            : "—"}
                        </span>
                        <span role="cell">
                          <span
                            className={`coverage-badge ${service.coverageLevel}`}
                          >
                            {coverageLabels[service.coverageLevel]}
                          </span>
                        </span>
                      </summary>
                      <div className="breakdown">
                        {service.breakdown.length > 0 ? (
                          <div className="breakdown-grid">
                            {service.breakdown.map((item) => (
                              <div
                                key={`${item.region}-${item.family}`}
                                className="breakdown-item"
                              >
                                <span>{item.region}</span>
                                <strong>{item.family}</strong>
                                <small>
                                  실행 자원 {item.running}개 · 활성 RI 수량{" "}
                                  {item.reserved}
                                </small>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p>조회된 실행 자원이 없습니다.</p>
                        )}
                        {service.errors.map((serviceError) => (
                          <p className="service-error" key={serviceError}>
                            {serviceError}
                          </p>
                        ))}
                      </div>
                    </details>
                  );
                })}
              </div>
            </section>

            <section className="panel savings-plans-coverage-panel">
              <div className="panel-heading">
                <div>
                  <span className="section-index">
                    02 / SAVINGS PLANS DISCOUNT COVERAGE
                  </span>
                  <h2>서비스별 Savings Plans 할인 적용률</h2>
                </div>
                <span className="updated-at">
                  {report.coverageWindow.start} —{" "}
                  {inclusiveEndDate(report.coverageWindow.end)}
                </span>
              </div>

              {report.savingsPlansCoverage.services.length > 0 ? (
                <div className="sp-coverage-table" role="table">
                  <div className="sp-coverage-row table-head" role="row">
                    <span role="columnheader">AWS 서비스</span>
                    <span role="columnheader">
                      <TermWithTooltip
                        label="SP 적용 비용"
                        description="Savings Plans 할인이 적용된 사용량의 On-Demand 환산 비용입니다. 실제 청구된 SP 약정 비용과는 다릅니다."
                      />
                    </span>
                    <span role="columnheader">
                      <TermWithTooltip
                        label="SP 미적용 할인 대상 비용"
                        description="Savings Plans 적용 대상이지만 약정이 적용되지 않아 On-Demand로 청구된 비용입니다."
                      />
                    </span>
                    <span role="columnheader">
                      <TermWithTooltip
                        label="SP 적용 대상 전체 비용"
                        description="SP 적용 비용과 SP 미적용 할인 대상 비용을 합한 On-Demand 환산 비용입니다."
                      />
                    </span>
                    <span role="columnheader">
                      <TermWithTooltip
                        label="SP 할인 적용률"
                        description="SP 적용 비용 ÷ SP 적용 대상 전체 비용입니다."
                      />
                    </span>
                  </div>
                  {report.savingsPlansCoverage.services.map((service) => (
                    <div className="sp-coverage-row" role="row" key={service.service}>
                      <span role="cell">
                        <strong>{service.service}</strong>
                      </span>
                      <span role="cell">
                        {formatCurrency(service.spendCoveredUsd)}
                      </span>
                      <span role="cell">
                        {formatCurrency(service.onDemandCostUsd)}
                      </span>
                      <span role="cell">
                        {formatCurrency(service.totalCostUsd)}
                      </span>
                      <span role="cell">
                        <strong>
                          {formatPercentage(service.coveragePercentage)}
                        </strong>
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="coverage-empty" role="status">
                  <strong>
                    {metricStatusLabels[report.savingsPlansCoverage.status]}
                  </strong>
                  <span>
                    {report.savingsPlansCoverage.message ??
                      "서비스별 Savings Plans 할인 적용 데이터를 조회할 수 없습니다."}
                  </span>
                </div>
              )}
            </section>

            <section
              className="panel findings-panel action-items-section"
              id="actions"
            >
              <div className="panel-heading">
                <div>
                  <span className="section-index">ACTION ITEMS</span>
                  <h2>조치가 필요한 항목</h2>
                </div>
                <span className="count-pill">{report.findings.length}</span>
              </div>
              <div className="findings-list">
                {report.findings.slice(0, 8).map((finding) => (
                  <div className="finding" key={finding.id}>
                    <span className={`finding-mark ${finding.severity}`} />
                    <div>
                      <div className="finding-title">
                        <strong>{finding.title}</strong>
                        <span className="finding-meta">
                          {finding.impactUsd !== null && (
                            <strong>
                              30일 영향 {formatCurrency(finding.impactUsd)}
                            </strong>
                          )}
                          <span>{finding.service}</span>
                        </span>
                      </div>
                      <p>{finding.detail}</p>
                      {finding.action && (
                        <p className="finding-action">
                          <strong>권장 조치</strong>
                          {finding.action}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <p className="data-footnote">
              마지막 AWS 조회 {formatDateTime(report.generatedAt)} · 조회 기간은
              오늘을 제외한 최근 완료 30일(UTC) · 절감액은 Cost Explorer의 Net
              Savings 기준 · 모든 금액은 USD
            </p>
          </>
        ) : null}
      </main>
      {managerOpen && (
        <EnvironmentManager
          environments={environments}
          token={token}
          onClose={() => setManagerOpen(false)}
          onChanged={handleEnvironmentsChanged}
        />
      )}
    </div>
  );
}
