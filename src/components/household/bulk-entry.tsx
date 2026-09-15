"use client";

import Link from "next/link";
import { ArrowLeft, ClipboardPaste, Copy, Plus, X } from "lucide-react";
import * as React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { MAX_PASTE_ROWS, splitMatrix } from "@/lib/household/paste";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { LoadingState, PageShell, SectionCard } from "@/components/page-shell";
import { HhPageHeader } from "@/components/household/hh-page-header";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { getOwnerUid } from "@/lib/household/owner";
import { HH_COL, tableMinWidth, colStyles } from "@/components/household/hh-board";

type SB = ReturnType<typeof createClient>;

// 여러 건 등록 그리드의 편집 칸 스타일 — 결제관리 인라인 편집과 톤 통일.
export const bulkCellInput =
  "w-full rounded-md border border-input/60 bg-muted/40 px-2 py-1.5 text-base md:text-sm transition-colors hover:border-input hover:bg-background focus:border-ring focus:bg-background focus:outline-none focus:ring-1 focus:ring-ring/40";
export const bulkSelectClass = `${bulkCellInput} h-9`;

/** 열 폭은 width(px) — HH_COL 척도에서 고른다. 생략하면 가변(남는 폭을 가변 열끼리 균등 분배). (설계 122) */
export type BulkColumn = { label: string; width?: number; align?: "right" };

export type BulkEntryProps<Row, O> = {
  title: string;
  breadcrumbs: { label: string; href?: string }[];
  backHref: string;
  listHref: string;
  /** 표 위 안내 문구(선택) */
  hint?: React.ReactNode;
  addLabel?: string;
  columns: BulkColumn[];
  /** 마스터 옵션 로드. null 반환 시 "마스터 없음" 안내를 띄운다. */
  loadOptions: (supabase: SB) => Promise<O | null>;
  missingMastersMessage?: React.ReactNode;
  /** 새 행 생성. prev = 직전 행(날짜 등 공통값 승계용) */
  emptyRow: (prev?: Row) => Row;
  /** 빈 행 판정(저장 대상에서 제외) */
  isEmpty: (row: Row) => boolean;
  /** 행 검증. 문제 없으면 null, 있으면 사유 문자열 */
  validate: (row: Row) => string | null;
  /** 합계 표시용 금액 */
  amountOf: (row: Row) => number;
  /** 컬럼 순서에 맞춰 입력 컨트롤 배열을 반환(열 개수 = columns.length). 표/카드 양쪽에서 재사용. */
  renderCells: (row: Row, update: (patch: Partial<Row>) => void, options: O) => React.ReactNode[];
  /** 검증 통과한 비어있지 않은 행들을 저장. 부분 실패 없이 원자적으로 처리할 것. */
  onSubmit: (supabase: SB, rows: Row[], owner: string) => Promise<{ count: number; error?: string }>;
  successMessage: (count: number) => string;
  /** 엑셀/표 붙여넣기 파서. 2차원 셀 배열 → 행 배열. 있으면 "엑셀에서 붙여넣기" UI 노출. */
  parsePaste?: (matrix: string[][], options: O) => { rows: Row[]; skipped: number };
  /** 붙여넣기 영역에 보일 컬럼 순서 안내. */
  pasteHint?: React.ReactNode;
};

export function BulkEntry<Row, O>({
  title,
  breadcrumbs,
  backHref,
  listHref,
  hint,
  addLabel = "행 추가",
  columns,
  loadOptions,
  missingMastersMessage,
  emptyRow,
  isEmpty,
  validate,
  amountOf,
  renderCells,
  onSubmit,
  successMessage,
  parsePaste,
  pasteHint,
}: BulkEntryProps<Row, O>) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();

  const [options, setOptions] = useState<O | null>(null);
  const [mastersOk, setMastersOk] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rows, setRows] = useState<Row[]>(() => [emptyRow()]);
  // 행별 검증 오류(인덱스 정렬). 저장 시도 후에만 채워짐.
  const [errors, setErrors] = useState<(string | null)[]>([]);
  // 저장 후 계속 입력(기본 ON) — 연속 입력 흐름 유지. (설계 docs/household/60 R2)
  const [keepEntering, setKeepEntering] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.localStorage.getItem("hh-bulk-keep-entering") !== "0";
  });
  const toggleKeepEntering = useCallback((on: boolean) => {
    setKeepEntering(on);
    try {
      window.localStorage.setItem("hh-bulk-keep-entering", on ? "1" : "0");
    } catch {
      /* localStorage 불가 환경은 세션 내 상태만 유지 */
    }
  }, []);
  // 엑셀 붙여넣기 영역
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");

  const load = useCallback(async () => {
    const o = await loadOptions(supabase);
    if (o === null) setMastersOk(false);
    else setOptions(o);
    setLoading(false);
  }, [supabase, loadOptions]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = useCallback((idx: number, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }, []);
  const addRow = useCallback(() => setRows((rs) => [...rs, emptyRow(rs[rs.length - 1])]), [emptyRow]);
  const dupRow = useCallback((idx: number) => setRows((rs) => [...rs.slice(0, idx + 1), { ...rs[idx] }, ...rs.slice(idx + 1)]), []);
  const removeRow = useCallback((idx: number) => setRows((rs) => (rs.length === 1 ? [emptyRow()] : rs.filter((_, i) => i !== idx))), [emptyRow]);

  const applyPaste = useCallback(() => {
    if (!parsePaste || !options) return;
    let matrix = splitMatrix(pasteText);
    if (matrix.length === 0) {
      toast.error("붙여넣을 내용이 없습니다.");
      return;
    }
    let truncated = 0;
    if (matrix.length > MAX_PASTE_ROWS) {
      truncated = matrix.length - MAX_PASTE_ROWS;
      matrix = matrix.slice(0, MAX_PASTE_ROWS);
    }
    const { rows: parsed, skipped } = parsePaste(matrix, options);
    if (parsed.length === 0) {
      toast.error("인식된 행이 없습니다. 컬럼 순서를 확인해주세요.");
      return;
    }
    // 기존 입력에서 빈 행은 버리고, 내용 있는 행 뒤에 누적.
    setRows((rs) => {
      const kept = rs.filter((r) => !isEmpty(r));
      return [...kept, ...parsed];
    });
    setErrors([]);
    setPasteText("");
    setPasteOpen(false);
    const extra = [skipped ? `${skipped}행 건너뜀` : "", truncated ? `${MAX_PASTE_ROWS}행 초과분 ${truncated}행 제외` : ""].filter(Boolean).join(", ");
    toast.success(`${parsed.length}행을 붙여넣었습니다.${extra ? ` (${extra})` : ""}`);
  }, [parsePaste, options, pasteText, isEmpty]);

  const nonEmpty = rows.filter((r) => !isEmpty(r));
  const total = nonEmpty.reduce((s, r) => s + (amountOf(r) || 0), 0);

  const submit = async () => {
    if (nonEmpty.length === 0) {
      toast.error("등록할 내용을 입력해주세요.");
      return;
    }
    const errs = rows.map((r) => (isEmpty(r) ? null : validate(r)));
    if (errs.some(Boolean)) {
      setErrors(errs);
      toast.error("입력값을 확인해주세요. (표시된 행)");
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      const owner = await getOwnerUid(supabase);
      if (!owner) {
        toast.error("로그인 정보를 확인할 수 없습니다.");
        return;
      }
      const res = await onSubmit(supabase, nonEmpty, owner);
      if (res.error) {
        toast.error(`등록 실패: ${res.error}`);
        return;
      }
      toast.success(successMessage(res.count));
      if (keepEntering) {
        // 연속 입력: 목록 이동 없이 그리드 초기화. 직전 행의 날짜·지불방식 등 공통값 승계. (설계 docs/household/60 R2)
        setRows([emptyRow(nonEmpty[nonEmpty.length - 1])]);
        setErrors([]);
      } else {
        router.push(listHref);
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingState label="불러오는 중..." />;

  // 데이터 열 + 맨 끝 행삭제 아이콘 열. (설계 122)
  const colWidths = [...columns.map((c) => c.width), HH_COL.icon];

  return (
    <PageShell>
      <HhPageHeader
        title={title}
        breadcrumbs={breadcrumbs}
        actions={
          <Button variant="outline" asChild>
            <Link href={backHref}>
              <ArrowLeft className="h-4 w-4" />
              취소
            </Link>
          </Button>
        }
      />

      <SectionCard>
        {!mastersOk ? (
          <p className="text-sm text-muted-foreground">{missingMastersMessage}</p>
        ) : (
          <div
            className="space-y-4"
            onKeyDown={(e) => {
              // Ctrl+Enter(⌘+Enter) = 등록. (설계 docs/household/60 R3)
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !saving) {
                e.preventDefault();
                void submit();
              }
            }}
          >
            {hint ? (
              <p className="inline-flex items-center gap-1.5 rounded-md bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700">{hint}</p>
            ) : null}

            {/* 엑셀/표 붙여넣기 */}
            {parsePaste ? (
              <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 p-3">
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-primary"
                  onClick={() => setPasteOpen((v) => !v)}
                >
                  <ClipboardPaste className="h-4 w-4" />
                  엑셀에서 붙여넣기 {pasteOpen ? "▴" : "▾"}
                </button>
                {pasteOpen ? (
                  <div className="mt-3 space-y-2">
                    {pasteHint ? <p className="text-xs text-muted-foreground">{pasteHint}</p> : null}
                    <textarea
                      value={pasteText}
                      onChange={(e) => setPasteText(e.target.value)}
                      placeholder="엑셀/구글시트에서 표 영역을 복사한 뒤 여기에 붙여넣기(Ctrl+V) 하세요."
                      rows={5}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 tabular-nums text-xs focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring/40"
                    />
                    <div className="flex justify-end gap-2">
                      <Button type="button" variant="ghost" size="sm" onClick={() => { setPasteText(""); setPasteOpen(false); }}>닫기</Button>
                      <Button type="button" size="sm" onClick={applyPaste} disabled={!pasteText.trim()}>행으로 추가</Button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* 데스크톱: 표 */}
            <div className="hidden w-fit max-w-full overflow-x-auto rounded-xl border border-border/70 md:block">
              {/* 열 폭 = 내용별(설계 122). 맨 끝은 행 삭제 버튼 전용 아이콘 열.
                  ★예전엔 '데이터 열은 전부 균등' 규칙 때문에 이 아이콘 열만 예외(data-uniform-exempt)로
                    빼야 했다. 이제는 아이콘 열도 척도(icon)를 쓰는 정상 열이라 예외가 필요 없다. */}
              <table className="table-fixed text-sm" style={{ width: tableMinWidth(colWidths) }}>
                <colgroup>
                  {colStyles(colWidths).map((st, i) => <col key={i} style={st} />)}
                </colgroup>
                <thead className="text-left text-xs text-muted-foreground">
                  <tr className="border-b border-border/60 bg-muted/30">
                    {columns.map((c, i) => (
                      <th key={i} className={`px-3 py-2.5 font-medium ${c.align === "right" ? "text-right" : ""}`}>
                        {c.label}
                      </th>
                    ))}
                    <th className="px-3 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => {
                    const err = errors[idx];
                    const cells = renderCells(row, (patch) => update(idx, patch), options as O);
                    return (
                      <tr key={idx} className={`border-b border-border/40 last:border-0 ${err ? "bg-rose-50/60" : ""}`} title={err ?? undefined}>
                        {cells.map((cell, i) => (
                          <td key={i} className={`px-2 py-1.5 ${columns[i]?.align === "right" ? "text-right" : ""}`}>
                            {cell}
                          </td>
                        ))}
                        <td className="px-2 py-1.5">
                          <div className="flex items-center justify-end gap-0.5">
                            <Button type="button" variant="ghost" size="sm" className="size-7 p-0 text-muted-foreground" title="이 행 복제" onClick={() => dupRow(idx)}>
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                            <Button type="button" variant="ghost" size="sm" className="size-7 p-0 text-muted-foreground hover:text-rose-600" title="이 행 삭제" onClick={() => removeRow(idx)}>
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* 모바일: 행을 카드로 (가로 스크롤 대신 세로 스택) */}
            <div className="space-y-3 md:hidden">
              {rows.map((row, idx) => {
                const err = errors[idx];
                const cells = renderCells(row, (patch) => update(idx, patch), options as O);
                return (
                  <div key={idx} className={`rounded-2xl border p-3 shadow-sm ${err ? "border-rose-300 bg-rose-50/60" : "border-border/70 bg-card/85"}`}>
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-semibold text-muted-foreground">{idx + 1}번</span>
                      <div className="flex items-center gap-0.5">
                        <Button type="button" variant="ghost" size="sm" className="size-10 p-0 text-muted-foreground md:size-7" title="이 행 복제" onClick={() => dupRow(idx)}>
                          <Copy className="h-4 w-4 md:h-3.5 md:w-3.5" />
                        </Button>
                        <Button type="button" variant="ghost" size="sm" className="size-10 p-0 text-muted-foreground hover:text-rose-600 md:size-7" title="이 행 삭제" onClick={() => removeRow(idx)}>
                          <X className="h-5 w-5 md:h-4 md:w-4" />
                        </Button>
                      </div>
                    </div>
                    <div className="space-y-2.5">
                      {cells.map((cell, i) => (
                        <div key={i}>
                          <label className="mb-1 block text-[11px] font-medium text-muted-foreground">{columns[i]?.label}</label>
                          {cell}
                        </div>
                      ))}
                    </div>
                    {err ? <p className="mt-2 text-xs font-medium text-rose-600">{err}</p> : null}
                  </div>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button type="button" variant="outline" size="sm" onClick={addRow}>
                <Plus className="h-4 w-4" />
                {addLabel}
              </Button>
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={keepEntering}
                    onChange={(e) => toggleKeepEntering(e.target.checked)}
                  />
                  저장 후 계속 입력
                </label>
                <span className="text-sm text-muted-foreground">
                  유효 <b className="text-foreground">{nonEmpty.length}</b>건 · 합계 <b className="tabular-nums text-foreground">{total.toLocaleString("ko-KR")}원</b>
                </span>
                <Button type="button" title="Ctrl+Enter로도 등록됩니다" onClick={() => void submit()} disabled={saving || nonEmpty.length === 0}>
                  {saving ? "저장 중..." : `${nonEmpty.length}건 등록`}
                </Button>
              </div>
            </div>
          </div>
        )}
      </SectionCard>
    </PageShell>
  );
}

// 로컬 기준 오늘(YYYY-MM-DD). toISOString()은 UTC라 밤시간 하루 밀림 방지.
export function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
