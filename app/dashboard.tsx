"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type {
  AiAuditReport,
  AiAuditResponse,
  AiAuditRunResponse,
  AiAuditSummary,
  ApiError,
  CostDetailPageResponse,
  EnvironmentId,
  EnvironmentInput,
  EnvironmentSummary,
  EnvironmentsResponse,
} from "../lib/cloudboard";

const emptyEnvironment: EnvironmentInput = {
  id: "",
  name: "",
  group: "",
  regions: ["ap-northeast-2"],
  credentialRef: "",
};

const statusLabels: Record<AiAuditSummary["status"], string> = {
  normal: "특이사항 없음",
  attention: "확인 필요",
  critical: "큰 변동",
  unavailable: "확인 불가",
};
const costDetailPageSize = 100;
const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const percentageFormatter = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 2,
});

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatUsd(value: number) {
  return usdFormatter.format(value);
}

function CostChangeDetails({
  details,
  environmentId,
}: {
  details: AiAuditReport["costChanges"];
  environmentId: EnvironmentId;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<CostDetailPageResponse["items"]>([]);
  const [total, setTotal] = useState(details.totalItems);
  const [cursor, setCursor] = useState(0);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [pageStarts, setPageStarts] = useState([0]);
  const [pageIndex, setPageIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [retryTarget, setRetryTarget] = useState<{
    cursor: number;
    pageIndex: number;
  } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  const rangeStart = items.length > 0 ? cursor + 1 : 0;
  const rangeEnd = cursor + items.length;

  const loadPage = useCallback(async (
    requestedCursor: number,
    requestedPageIndex: number,
    moveFocus = false,
  ) => {
    if (
      loading ||
      !details.basisDate ||
      !details.reportGeneratedAt
    ) {
      return;
    }
    setLoading(true);
    setDetailError(null);
    setRetryTarget(null);
    try {
      const query = new URLSearchParams({
        environment: environmentId,
        basisDate: details.basisDate,
        reportGeneratedAt: details.reportGeneratedAt,
        cursor: String(requestedCursor),
        limit: String(costDetailPageSize),
      });
      const response = await fetch(`/api/reports/cost-details?${query}`, {
        cache: "no-store",
      });
      const body = (await response.json()) as CostDetailPageResponse | ApiError;
      if (!response.ok || !("items" in body)) {
        throw new Error("error" in body ? body.error : "비용 상세를 불러오지 못했습니다.");
      }
      if (
        body.basisDate !== details.basisDate ||
        body.reportGeneratedAt !== details.reportGeneratedAt
      ) {
        throw new Error("비용 상세 보고서가 변경되었습니다. 새로고침해 주세요.");
      }
      setItems(body.items);
      setTotal(body.total);
      setCursor(body.cursor);
      setNextCursor(body.nextCursor);
      setPageIndex(requestedPageIndex);
      setPageStarts((current) => {
        const updated = current.slice(0, requestedPageIndex + 1);
        updated[requestedPageIndex] = body.cursor;
        if (body.nextCursor !== null) {
          updated[requestedPageIndex + 1] = body.nextCursor;
        }
        return updated;
      });
      setLoaded(true);
      const start = body.items.length > 0 ? body.cursor + 1 : 0;
      setAnnouncement(
        `비용 상승 항목 ${start}번부터 ${body.cursor + body.items.length}번까지 불러왔습니다.`,
      );
      if (moveFocus) {
        requestAnimationFrame(() => listRef.current?.focus());
      }
    } catch (error) {
      setRetryTarget({
        cursor: requestedCursor,
        pageIndex: requestedPageIndex,
      });
      setDetailError(
        error instanceof Error ? error.message : "비용 상세를 불러오지 못했습니다.",
      );
    } finally {
      setLoading(false);
    }
  }, [
    details.basisDate,
    details.reportGeneratedAt,
    environmentId,
    loading,
  ]);

  return (
    <details
      className="cost-details"
      onToggle={(event) => {
        const isOpen = event.currentTarget.open;
        setOpen(isOpen);
        if (isOpen && !loaded && total > 0) void loadPage(0, 0);
      }}
    >
      <summary>
        <span>상세</span>
        <small>상승 항목 {total}개</small>
      </summary>
      {open && (
        <div className="cost-details-panel">
          <p>
            {!details.comparisonAvailable
              ? "새 비용 상세 데이터가 아직 없습니다. 새 요약을 생성하면 확인할 수 있습니다."
              : details.basisDate
                ? `${details.basisDate} 비용을 최근 동일 요일 ${details.baselineDates.length}회 중앙값과 비교했습니다.`
                : "비용 상승 항목을 계산할 수 있는 기준 데이터가 없습니다."}
          </p>
          {detailError && (
            <p className="cost-detail-error" role="alert">{detailError}</p>
          )}
          {details.comparisonAvailable && total > 0 ? (
            <>
              <ul
                ref={listRef}
                className="cost-change-list"
                tabIndex={0}
                aria-label={`비용 상승 항목 ${rangeStart}–${rangeEnd}, 전체 ${total}개`}
              >
                {items.map((item) => (
                  <li key={`${item.service}:${item.usageType ?? ""}`}>
                    <div>
                      <strong>{item.service}</strong>
                      {item.usageType && <span>{item.usageType}</span>}
                      <small>
                        기준일 {formatUsd(item.basisCostUsd)} · 비교 기준 {formatUsd(item.weekdayMedianCostUsd)}
                      </small>
                    </div>
                    <div className="cost-increase">
                      <strong>+{formatUsd(item.increaseUsd)}</strong>
                      <small>
                        {item.increasePercentage === null
                          ? item.isNew
                            ? "동일 요일 기준 신규"
                            : "금액 기준 비교"
                          : `+${percentageFormatter.format(item.increasePercentage)}%`}
                      </small>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="cost-details-pagination" aria-label="비용 상승 항목 페이지">
                <button
                  type="button"
                  disabled={loading || pageIndex === 0}
                  onClick={() => void loadPage(pageStarts[pageIndex - 1], pageIndex - 1, true)}
                >
                  이전
                </button>
                <span>{rangeStart}–{rangeEnd} / {total}</span>
                <button
                  type="button"
                  disabled={loading || (nextCursor === null && !detailError)}
                  onClick={() => void loadPage(
                    retryTarget?.cursor ?? nextCursor ?? cursor,
                    retryTarget?.pageIndex ?? pageIndex + 1,
                    true,
                  )}
                >
                  {loading ? "불러오는 중" : detailError ? "다시 시도" : "다음"}
                </button>
              </div>
              <p className="sr-only" role="status">{announcement}</p>
            </>
          ) : (
            details.comparisonAvailable && (
              <p className="no-cost-increase">비교 기준보다 상승한 비용 항목이 없습니다.</p>
            )
          )}
        </div>
      )}
    </details>
  );
}

function SummaryCard({
  label,
  icon,
  summary,
  costDetails,
  environmentId,
}: {
  label: string;
  icon: string;
  summary: AiAuditSummary;
  costDetails?: AiAuditReport["costChanges"];
  environmentId?: EnvironmentId;
}) {
  return (
    <article className={`summary-card ${summary.status}`}>
      <header>
        <div className="summary-label">
          <span aria-hidden="true">{icon}</span>
          <strong>{label}</strong>
        </div>
        <span className={`summary-status ${summary.status}`}>
          {statusLabels[summary.status]}
        </span>
      </header>
      <h2>{summary.headline}</h2>
      <p>{summary.summary}</p>
      {costDetails && environmentId ? (
        <CostChangeDetails details={costDetails} environmentId={environmentId} />
      ) : summary.highlights.length > 0 && (
        <ul>
          {summary.highlights.map((highlight) => (
            <li key={highlight}>{highlight}</li>
          ))}
        </ul>
      )}
    </article>
  );
}

function EnvironmentManager({
  environments,
  onClose,
  onChanged,
}: {
  environments: EnvironmentSummary[];
  onClose: () => void;
  onChanged: (preferredId?: string, deletedId?: string) => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const [form, setForm] = useState<EnvironmentInput>(emptyEnvironment);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    previouslyFocused.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const focusable = dialog.current?.querySelectorAll<HTMLElement>(
        "button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])",
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused.current?.focus();
    };
  }, [onClose]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/environments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...form,
          regions: form.regions[0]
            .split(",")
            .map((region) => region.trim())
            .filter(Boolean),
        }),
      });
      const body = (await response.json()) as EnvironmentSummary | ApiError;
      if (!response.ok || "error" in body) {
        throw new Error("error" in body ? body.error : "환경을 추가하지 못했습니다.");
      }
      setForm(emptyEnvironment);
      onChanged(body.id);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "환경을 추가하지 못했습니다.",
      );
    } finally {
      setSaving(false);
    }
  };

  const remove = async (environment: EnvironmentSummary) => {
    if (!window.confirm(`${environment.name} 환경을 목록에서 삭제할까요?`)) return;
    setError(null);
    try {
      const response = await fetch(`/api/environments/${environment.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const body = (await response.json()) as ApiError;
        throw new Error(body.error);
      }
      onChanged(undefined, environment.id);
    } catch (removeError) {
      setError(
        removeError instanceof Error
          ? removeError.message
          : "환경을 삭제하지 못했습니다.",
      );
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialog}
        className="environment-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="environment-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>SETTINGS</span>
            <h2 id="environment-dialog-title">AWS 환경 관리</h2>
          </div>
          <button ref={closeButton} type="button" onClick={onClose} aria-label="닫기">
            ×
          </button>
        </header>

        <div className="environment-list">
          {environments.map((environment) => (
            <div key={environment.id}>
              <span className={environment.configured ? "connected" : "missing"} />
              <p>
                <strong>{environment.name}</strong>
                <small>{environment.group} · {environment.id}</small>
              </p>
              <button type="button" onClick={() => void remove(environment)}>
                삭제
              </button>
            </div>
          ))}
          {environments.length === 0 && <p className="empty-list">등록된 환경이 없습니다.</p>}
        </div>

        <form className="environment-form" onSubmit={submit}>
          <h3>환경 추가</h3>
          <label>
            <span>환경 ID</span>
            <input
              required
              value={form.id}
              onChange={(event) =>
                setForm((current) => ({ ...current, id: event.target.value.toLowerCase() }))
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
                setForm((current) => ({ ...current, name: event.target.value }))
              }
              placeholder="B2B Development"
            />
          </label>
          <label>
            <span>그룹</span>
            <input
              required
              value={form.group}
              onChange={(event) =>
                setForm((current) => ({ ...current, group: event.target.value }))
              }
              placeholder="B2B"
            />
          </label>
          <label>
            <span>AWS 리전</span>
            <input
              required
              value={form.regions[0]}
              onChange={(event) =>
                setForm((current) => ({ ...current, regions: [event.target.value] }))
              }
              placeholder="ap-northeast-2"
            />
          </label>
          <label className="full-field">
            <span>자격 증명 참조</span>
            <input
              value={form.credentialRef}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  credentialRef: event.target.value.toLowerCase(),
                }))
              }
              placeholder="비우면 환경 ID 사용"
            />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="submit-button" type="submit" disabled={saving}>
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
    Partial<Record<EnvironmentId, AiAuditReport | null>>
  >({});
  const [aiConfigured, setAiConfigured] = useState<boolean>();
  const [loadingEnvironments, setLoadingEnvironments] = useState(true);
  const [loadingReport, setLoadingReport] = useState<EnvironmentId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);

  const loadEnvironments = useCallback(
    async (preferredId?: string) => {
      setLoadingEnvironments(true);
      setError(null);
      try {
        const response = await fetch("/api/environments", {
          cache: "no-store",
        });
        const body = (await response.json()) as EnvironmentsResponse | ApiError;
        if (!response.ok || !("environments" in body)) {
          throw new Error("error" in body ? body.error : "환경을 불러오지 못했습니다.");
        }
        setEnvironments(body.environments);
        setEnvironment((current) => {
          if (preferredId && body.environments.some((item) => item.id === preferredId)) {
            return preferredId;
          }
          if (current && body.environments.some((item) => item.id === current)) {
            return current;
          }
          return body.environments[0]?.id ?? null;
        });
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "환경을 불러오지 못했습니다.");
      } finally {
        setLoadingEnvironments(false);
      }
    },
    [],
  );

  const loadReport = useCallback(
    async (environmentId: EnvironmentId, generate = false) => {
      setLoadingReport(environmentId);
      setError(null);
      try {
        const query = new URLSearchParams({ environment: environmentId });
        const response = await fetch(`/api/reports/ai-audit?${query}`, {
          method: generate ? "POST" : "GET",
          cache: "no-store",
        });
        const body = (await response.json()) as AiAuditResponse | AiAuditRunResponse | ApiError;
        if (!response.ok) {
          throw new Error("error" in body ? body.error : "AI 요약을 불러오지 못했습니다.");
        }
        if ("errors" in body) {
          const environmentError = body.errors.find(
            (item) => item.environmentId === environmentId,
          );
          if (environmentError && !body.reports.some(
            (item) => item.environmentId === environmentId,
          )) {
            throw new Error(environmentError.message);
          }
        }
        if ("configured" in body) setAiConfigured(body.configured);
        const report =
          "reports" in body
            ? (body.reports.find((item) => item.environmentId === environmentId) ?? null)
            : "report" in body
              ? body.report
              : null;
        setReports((current) => ({ ...current, [environmentId]: report }));
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "AI 요약을 불러오지 못했습니다.");
      } finally {
        setLoadingReport(null);
      }
    },
    [],
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadEnvironments(), 0);
    return () => window.clearTimeout(timeout);
  }, [loadEnvironments]);

  useEffect(() => {
    if (environment && !(environment in reports)) {
      const timeout = window.setTimeout(() => void loadReport(environment), 0);
      return () => window.clearTimeout(timeout);
    }
  }, [environment, loadReport, reports]);

  const environmentsChanged = (preferredId?: string, deletedId?: string) => {
    if (deletedId) {
      setReports((current) => {
        const next = { ...current };
        delete next[deletedId];
        return next;
      });
    }
    void loadEnvironments(preferredId);
  };

  const selected = environments.find((item) => item.id === environment);
  const report = environment ? reports[environment] : undefined;
  const reportLoading = loadingReport === environment;

  return (
    <div className="cloudboard">
      <header className="app-header">
        <a className="brand" href="#top" aria-label="CloudBoard 홈">
          <span>C</span>
          <strong>CloudBoard</strong>
        </a>
        <div className="header-actions">
          <button className="secondary-button" type="button" onClick={() => setManagerOpen(true)}>
            환경 관리
          </button>
        </div>
      </header>

      <main id="top">
        <section className="page-heading">
          <div>
            <span>AWS DAILY BRIEF</span>
            <h1>비용과 자원 변경 요약</h1>
            <p>AI가 AWS 데이터를 읽고, 달라진 내용만 짧게 정리합니다.</p>
          </div>
          {environment && selected?.configured && (
            <button
              className="primary-button"
              type="button"
              disabled={reportLoading}
              onClick={() => void loadReport(environment, true)}
            >
              {reportLoading ? "AWS 확인 중…" : report ? "새 요약 생성" : "첫 요약 생성"}
            </button>
          )}
        </section>

        <section className="environment-switcher" aria-label="AWS 환경 선택">
          {environments.map((item) => (
            <button
              type="button"
              className={environment === item.id ? "selected" : ""}
              key={item.id}
              onClick={() => setEnvironment(item.id)}
              aria-pressed={environment === item.id}
            >
              <span className={item.configured ? "connected" : "missing"} />
              <strong>{item.name}</strong>
              <small>{item.group} · {item.id.toUpperCase()}</small>
            </button>
          ))}
        </section>

        {error && <div className="error-banner" role="alert">{error}</div>}

        {loadingEnvironments ? (
          <div className="empty-state" role="status">환경을 불러오는 중입니다.</div>
        ) : !environment ? (
          <div className="empty-state">
            <strong>AWS 환경이 없습니다</strong>
            <button type="button" onClick={() => setManagerOpen(true)}>환경 추가</button>
          </div>
        ) : !selected?.configured ? (
          <div className="empty-state">
            <strong>AWS 연결 정보가 없습니다</strong>
            <p>{selected?.credentialRef} 자격 증명을 서버에 설정해 주세요.</p>
          </div>
        ) : aiConfigured === false ? (
          <div className="empty-state">
            <strong>AI 연결 정보가 없습니다</strong>
            <p>서버에 OPENAI_API_KEY를 설정하면 요약을 생성할 수 있습니다.</p>
          </div>
        ) : reportLoading && !report ? (
          <div className="empty-state loading-state" role="status">
            <span />
            <strong>AWS 변경 내용을 확인하고 있습니다</strong>
          </div>
        ) : report ? (
          <>
            <div className="report-meta">
              <span>{report.environmentName}</span>
              <span>{formatDateTime(report.generatedAt)} 기준</span>
              {report.costBasis?.basisDate && (
                <span className={report.costBasis.dataStatus === "delayed" ? "partial" : undefined}>
                  비용 기준 {report.costBasis.basisDate} · {report.costBasis.dataStatus === "delayed"
                    ? `집계 지연 (예상 ${report.costBasis.expectedBasisDate})`
                    : "KST T-2 안정화 기준"}
                </span>
              )}
              {report.status === "partial" && <span className="partial">일부 데이터 조회 제한</span>}
            </div>
            <section className="summary-grid" aria-label="AI AWS 요약">
              <SummaryCard
                key={`${report.environmentId}:${report.generatedAt}:cost`}
                label="비용 변동"
                icon="$"
                summary={report.cost}
                environmentId={report.environmentId}
                costDetails={report.costChanges ?? {
                  comparison: "same-weekday-median",
                  comparisonAvailable: false,
                  basisDate: report.costBasis?.basisDate ?? null,
                  reportGeneratedAt: null,
                  baselineDates: [],
                  totalItems: 0,
                }}
              />
              <SummaryCard
                key={`${report.environmentId}:${report.generatedAt}:resources`}
                label="자원 변경"
                icon="↻"
                summary={report.resourceChanges}
              />
            </section>
          </>
        ) : (
          <div className="empty-state">
            <strong>아직 생성된 요약이 없습니다</strong>
            <p>버튼을 누르면 최근 비용과 24시간 자원 변경을 확인합니다.</p>
            <button type="button" onClick={() => void loadReport(environment, true)}>
              첫 요약 생성
            </button>
          </div>
        )}
      </main>

      {managerOpen && (
        <EnvironmentManager
          environments={environments}
          onClose={() => setManagerOpen(false)}
          onChanged={environmentsChanged}
        />
      )}
    </div>
  );
}
