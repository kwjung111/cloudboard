"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ApiError,
  CommitmentMetricSet,
  EnvironmentId,
  EnvironmentReport,
  MetricValue,
} from "../lib/cloudboard";

const environments: { id: EnvironmentId; label: string; short: string }[] = [
  { id: "dev", label: "Development", short: "DEV" },
  { id: "prd", label: "Production", short: "PRD" },
];

const coverageLabels = {
  good: "안정",
  attention: "점검",
  risk: "위험",
  unknown: "대상 없음",
};

const metricStatusLabels = {
  ready: "집계 완료",
  pending: "집계 대기",
  unavailable: "데이터 없음",
  error: "조회 실패",
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

function metricText(metric: MetricValue, type: "percentage" | "currency") {
  if (metric.status !== "ready") {
    return metricStatusLabels[metric.status];
  }
  return type === "percentage"
    ? formatPercentage(metric.value)
    : formatCurrency(metric.value);
}

function MetricSummaryCard({
  title,
  eyebrow,
  metrics,
}: {
  title: string;
  eyebrow: string;
  metrics: CommitmentMetricSet;
}) {
  return (
    <article className={`summary-card metric-summary ${metrics.coverage.status}`}>
      <span className="card-label">{title}</span>
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
        <span>약정 사용률</span>
        <strong>{metricText(metrics.utilization, "percentage")}</strong>
      </div>
      {metrics.coverage.message && (
        <p className="metric-message">{metrics.coverage.message}</p>
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
  environment,
  message,
}: {
  environment: EnvironmentId;
  message: string;
}) {
  const prefix = `AWS_${environment.toUpperCase()}`;
  return (
    <section className="empty-state">
      <span className="empty-eyebrow">환경 설정 필요</span>
      <h2>{message}</h2>
      <p>
        로컬의 <code>.env.local</code> 또는 배포 환경의 비밀 변수에 아래
        항목을 추가하세요. 키 파일은 저장소에 포함하지 않습니다.
      </p>
      <div className="config-keys">
        <code>{prefix}_ACCESS_KEY_ID</code>
        <code>{prefix}_SECRET_ACCESS_KEY</code>
        <code>{prefix}_REGIONS</code>
      </div>
    </section>
  );
}

export function CloudBoardDashboard() {
  const [environment, setEnvironment] = useState<EnvironmentId>("dev");
  const [reports, setReports] = useState<
    Partial<Record<EnvironmentId, EnvironmentReport>>
  >({});
  const [loading, setLoading] = useState<EnvironmentId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(() =>
    typeof window === "undefined"
      ? ""
      : (sessionStorage.getItem("cloudboard-access-token") ?? ""),
  );

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
    [token],
  );

  useEffect(() => {
    if (!reports[environment]) {
      const timeoutId = window.setTimeout(() => {
        void loadReport(environment);
      }, 0);
      return () => window.clearTimeout(timeoutId);
    }
  }, [environment, loadReport, reports]);

  const report = reports[environment];
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
        quantity: reservation.quantity,
        amount: null,
        end: reservation.end,
      })),
      ...report.savingsPlans.map((plan) => ({
        id: `sp-${plan.id}`,
        kind: "SP",
        title: `${plan.type} Savings Plan`,
        detail: plan.region ?? "Global",
        quantity: 1,
        amount: plan.hourlyCommitment,
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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">C</span>
          <div>
            <strong>CloudBoard</strong>
            <span>Commitment control</span>
          </div>
        </div>

        <nav className="primary-nav" aria-label="주요 메뉴">
          <a className="nav-item active" href="#overview" aria-current="page">
            <span>01</span>
            Overview
          </a>
          <a className="nav-item" href="#services">
            <span>02</span>
            Coverage
          </a>
          <a className="nav-item" href="#commitments">
            <span>03</span>
            Expirations
          </a>
        </nav>

        <div className="sidebar-footer">
          <span className="security-dot" />
          <div>
            <strong>Read-only connection</strong>
            <span>AWS credentials stay server-side</span>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <p className="eyebrow">AWS COST GOVERNANCE</p>
            <h1>Commitment Performance</h1>
          </div>
          <div className="topbar-actions">
            <label className="token-field">
              <span>Access token</span>
              <input
                type="password"
                value={token}
                onChange={(event) => handleTokenChange(event.target.value)}
                placeholder="Optional"
                autoComplete="current-password"
              />
            </label>
            <button
              className="refresh-button"
              type="button"
              onClick={() => void loadReport(environment, true)}
              disabled={loading !== null}
            >
              <span className={loading ? "refresh-icon spinning" : "refresh-icon"}>
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
                className={environment === item.id ? "selected" : ""}
                onClick={() => setEnvironment(item.id)}
              >
                <span>{item.short}</span>
                {reports[item.id]?.name ?? item.label}
              </button>
            ))}
          </div>
          <div className="environment-meta">
            <span
              className={`status-indicator ${report?.status ?? "loading"}`}
            />
            <span>{report ? formatAccountId(report.accountId) : "연결 중"}</span>
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
            <button type="button" onClick={() => void loadReport(environment)}>
              다시 시도
            </button>
          </div>
        )}

        {loading === environment && !report ? (
          <LoadingState />
        ) : report?.status === "unconfigured" ? (
          <EmptyState
            environment={environment}
            message={report.error ?? "AWS 환경 설정이 필요합니다."}
          />
        ) : report?.status === "failed" ? (
          <EmptyState
            environment={environment}
            message={report.error ?? "AWS 연결을 확인해 주세요."}
          />
        ) : report && summary ? (
          <>
            <section className="metric-guide" id="overview">
              <div>
                <strong>Coverage</strong>
                <span>전체 적격 사용량 중 약정 할인이 적용된 비율</span>
              </div>
              <span className="guide-divider" />
              <div>
                <strong>Utilization</strong>
                <span>구매한 약정 중 실제 워크로드가 소비한 비율</span>
              </div>
              <p>두 지표가 함께 높을수록 약정을 효율적으로 운용하고 있습니다.</p>
            </section>

            <section className="summary-grid">
              <MetricSummaryCard
                title="RI 성과"
                eyebrow="30일 커버리지"
                metrics={report.metrics.ri}
              />
              <MetricSummaryCard
                title="Savings Plans 성과"
                eyebrow="30일 커버리지"
                metrics={report.metrics.savingsPlans}
              />
              <article className="summary-card featured savings-summary">
                <span className="card-label">30일 실현 절감액</span>
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
                    : "동일 사용량의 On-Demand 비용 대비 순절감액"}
                </p>
              </article>
              <article className="summary-card expiry-summary">
                <span className="card-label">다음 약정 만료</span>
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
                  <span>RI {summary.activeRi}</span>
                  <span>SP {report.savingsPlans.length}</span>
                </div>
              </article>
            </section>

            <section className="panel service-panel" id="services">
              <div className="panel-heading">
                <div>
                  <span className="section-index">01 / RI COVERAGE</span>
                  <h2>서비스별 RI 커버리지</h2>
                </div>
                <span className="updated-at">
                  {report.coverageWindow.start} —{" "}
                  {inclusiveEndDate(report.coverageWindow.end)}
                </span>
              </div>

              <div className="service-table" role="table">
                <div className="service-row table-head" role="row">
                  <span role="columnheader">서비스</span>
                  <span role="columnheader">실행 / 활성 RI</span>
                  <span role="columnheader">RI 커버리지</span>
                  <span role="columnheader">가장 가까운 만료</span>
                  <span role="columnheader">상태</span>
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
                              {service.breakdown.length}개 구성 그룹
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
                                  실행 {item.running} · 활성 RI {item.reserved}
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

            <section className="lower-grid" id="commitments">
              <article className="panel findings-panel">
                <div className="panel-heading">
                  <div>
                    <span className="section-index">02 / FINDINGS</span>
                    <h2>우선 확인 항목</h2>
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
                          <span>{finding.service}</span>
                        </div>
                        <p>{finding.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </article>

              <article className="panel commitments-panel">
                <div className="panel-heading">
                  <div>
                    <span className="section-index">03 / EXPIRATIONS</span>
                    <h2>활성 약정 만료 일정</h2>
                  </div>
                  <span className="count-pill">
                    {summary.commitments.length}
                  </span>
                </div>
                {summary.commitments.length > 0 ? (
                  <div className="commitment-list">
                    {summary.commitments.map((commitment) => (
                      <div className="commitment" key={commitment.id}>
                        <span
                          className={`commitment-kind ${commitment.kind.toLowerCase()}`}
                        >
                          {commitment.kind}
                        </span>
                        <div>
                          <strong>{commitment.title}</strong>
                          <span>
                            {commitment.detail}
                            {commitment.quantity > 1
                              ? ` · ${commitment.quantity}개`
                              : ""}
                          </span>
                        </div>
                        <div>
                          {commitment.amount !== null && (
                            <strong>${commitment.amount.toFixed(2)}/h</strong>
                          )}
                          <span>
                            {commitment.end
                              ? `${formatDate(commitment.end)} · D-${daysUntil(
                                  commitment.end,
                                )}`
                              : "만료일 없음"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="no-commitments">
                    <span>RI</span>
                    <strong>활성 약정이 없습니다</strong>
                    <p>커버리지 목표와 워크로드 안정성을 먼저 검토하세요.</p>
                  </div>
                )}
              </article>
            </section>

            <p className="data-footnote">
              마지막 조회 {formatDateTime(report.generatedAt)} · 절감액은 AWS Cost
              Explorer의 Net Savings 기준 · 모든 금액은 USD
            </p>
          </>
        ) : null}
      </main>
    </div>
  );
}
