"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ApiError,
  EnvironmentId,
  EnvironmentReport,
  ServiceCoverage,
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

function formatPercentage(value: number | null) {
  return value === null ? "—" : `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
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

function weightedCoverage(services: ServiceCoverage[]) {
  const measurable = services.filter(
    (service) =>
      service.running > 0 &&
      (service.riCoveragePercentage !== null ||
        service.savingsPlansCoveragePercentage !== null),
  );
  const totalResources = measurable.reduce(
    (sum, service) => sum + service.running,
    0,
  );
  if (totalResources === 0) {
    return null;
  }

  return (
    measurable.reduce((sum, service) => {
      const combined = Math.max(
        service.riCoveragePercentage ?? 0,
        service.savingsPlansCoveragePercentage ?? 0,
      );
      return sum + combined * service.running;
    }, 0) / totalResources
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
          throw new Error("error" in body ? body.error : "조회에 실패했습니다.");
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
    return {
      coverage: weightedCoverage(report.services),
      running: report.services.reduce(
        (sum, service) => sum + service.running,
        0,
      ),
      reserved: report.services.reduce(
        (sum, service) => sum + service.reserved,
        0,
      ),
      risks: report.findings.filter(
        (finding) => finding.severity === "high",
      ).length,
      commitment: report.savingsPlans.reduce(
        (sum, plan) => sum + plan.hourlyCommitment,
        0,
      ),
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
            Coverage
          </a>
          <a className="nav-item" href="#services">
            <span>02</span>
            Resources
          </a>
          <a className="nav-item" href="#findings">
            <span>03</span>
            Findings
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
            <h1>RI &amp; Savings Plans Coverage</h1>
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
                {item.label}
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
            <section className="summary-grid" id="overview">
              <article className="summary-card featured">
                <span className="card-label">30일 가중 커버리지</span>
                <div className="coverage-value">
                  {summary.coverage === null
                    ? "—"
                    : `${Math.round(summary.coverage)}%`}
                </div>
                <div className="coverage-track">
                  <span
                    style={{ width: `${summary.coverage ?? 0}%` }}
                    aria-hidden="true"
                  />
                </div>
                <p>
                  {report.coverageWindow.start} — {report.coverageWindow.end}
                </p>
              </article>
              <article className="summary-card">
                <span className="card-index">01</span>
                <span className="card-label">실행 자원</span>
                <strong>{summary.running}</strong>
                <p>예약 용량 {summary.reserved}개</p>
              </article>
              <article className="summary-card">
                <span className="card-index">02</span>
                <span className="card-label">활성 Savings Plans</span>
                <strong>{report.savingsPlans.length}</strong>
                <p>${summary.commitment.toFixed(2)} / hour</p>
              </article>
              <article className="summary-card">
                <span className="card-index">03</span>
                <span className="card-label">우선 확인</span>
                <strong className={summary.risks > 0 ? "risk-number" : ""}>
                  {summary.risks}
                </strong>
                <p>높은 위험 항목</p>
              </article>
            </section>

            <section className="panel service-panel" id="services">
              <div className="panel-heading">
                <div>
                  <span className="section-index">01 / COVERAGE</span>
                  <h2>서비스별 커버리지</h2>
                </div>
                <span className="updated-at">
                  {formatDateTime(report.generatedAt)} 기준
                </span>
              </div>

              <div className="service-table" role="table">
                <div className="service-row table-head" role="row">
                  <span role="columnheader">서비스</span>
                  <span role="columnheader">실행 / 예약</span>
                  <span role="columnheader">RI</span>
                  <span role="columnheader">Savings Plans</span>
                  <span role="columnheader">상태</span>
                </div>
                {report.services.map((service) => (
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
                        {formatPercentage(
                          service.savingsPlansCoveragePercentage,
                        )}
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
                                실행 {item.running} · 예약 {item.reserved}
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
                ))}
              </div>
            </section>

            <section className="lower-grid" id="findings">
              <article className="panel findings-panel">
                <div className="panel-heading">
                  <div>
                    <span className="section-index">02 / FINDINGS</span>
                    <h2>우선 확인 항목</h2>
                  </div>
                  <span className="count-pill">{report.findings.length}</span>
                </div>
                <div className="findings-list">
                  {report.findings.slice(0, 6).map((finding) => (
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
                    <span className="section-index">03 / COMMITMENTS</span>
                    <h2>활성 Savings Plans</h2>
                  </div>
                </div>
                {report.savingsPlans.length > 0 ? (
                  <div className="commitment-list">
                    {report.savingsPlans.map((plan) => (
                      <div className="commitment" key={plan.id}>
                        <div>
                          <strong>{plan.type}</strong>
                          <span>{plan.region ?? "Global"}</span>
                        </div>
                        <div>
                          <strong>${plan.hourlyCommitment.toFixed(2)}/h</strong>
                          <span>
                            {plan.end
                              ? `${new Intl.DateTimeFormat("ko-KR").format(
                                  new Date(plan.end),
                                )} 만료`
                              : "만료일 없음"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="no-commitments">
                    <span>SP</span>
                    <strong>활성 플랜이 없습니다</strong>
                    <p>EC2 온디맨드 사용량과 구매 권장 사항을 확인하세요.</p>
                  </div>
                )}
              </article>
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}
