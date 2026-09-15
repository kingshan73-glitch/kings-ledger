"use client";

import { RotateCcw, Search, SlidersHorizontal } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateInput } from "@/components/ui/date-input";
import { cn } from "@/lib/utils";
import { presetRange, type RangePreset } from "@/lib/household/month";

export interface HhDateRange {
  start: string; // "YYYY-MM-DD" | ""
  end: string;
}

/** 상세 필터 값. 빈 문자열 = 전체. */
export interface HhAdvancedFilter {
  categoryId: string;
  methodId: string;
  accountId: string;
  amountMin: string;
  amountMax: string;
  /**
   * 카드 묶음(카드사·명의) 선택 — 소속 결제수단 id 들. (설계 86)
   * methodId(단일)로는 묶음을 표현 못 해 별도로 둔다. 있으면 membership 으로 판정.
   * 묶음엔 비활성 통합카드도 들어가므로, 옛 카드 이름을 몰라도 과거 거래까지 함께 조회된다.
   */
  methodIds?: string[];
  /** 묶음 표시 이름(선택값 복원·라벨용). 예: "삼성카드(이바다)" */
  methodGroup?: string;
}

export const EMPTY_ADVANCED_FILTER: HhAdvancedFilter = {
  categoryId: "",
  methodId: "",
  accountId: "",
  amountMin: "",
  amountMax: "",
};

/** 상세 필터가 하나라도 설정됐는지. */
export function hasAdvancedFilter(f: HhAdvancedFilter): boolean {
  return Boolean(f.categoryId || f.methodId || f.accountId || f.amountMin || f.amountMax || f.methodGroup);
}

/** 접이식 '상세조건'에 남은 항목(금액범위)만 설정됐는지 — 버튼 활성 표시용. (설계 83) */
function hasAmountFilter(f: HhAdvancedFilter): boolean {
  return Boolean(f.amountMin || f.amountMax);
}

/** 거래 한 건이 상세 필터를 통과하는지. (필드명은 hh_transaction 기준) */
export function passesAdvancedFilter(
  row: { category_id?: string | null; payment_method_id?: string | null; account_id?: string | null; amount: number },
  f: HhAdvancedFilter
): boolean {
  if (f.categoryId && row.category_id !== f.categoryId) return false;
  // 카드 묶음이 선택됐으면 소속 결제수단 중 하나면 통과(설계 86). 단일 methodId 보다 우선.
  if (f.methodIds && f.methodIds.length > 0) {
    if (!row.payment_method_id || !f.methodIds.includes(row.payment_method_id)) return false;
  } else if (f.methodId && row.payment_method_id !== f.methodId) return false;
  if (f.accountId && row.account_id !== f.accountId) return false;
  const min = f.amountMin ? Number(f.amountMin) : null;
  const max = f.amountMax ? Number(f.amountMax) : null;
  if (min != null && !Number.isNaN(min) && row.amount < min) return false;
  if (max != null && !Number.isNaN(max) && row.amount > max) return false;
  return true;
}

export interface HhFilterOption {
  id: string;
  name: string;
  /** 비활성(안 쓰는) 항목. 기본 목록에서 감추되 '비활성 포함'을 켜면 보인다. 생략 시 활성 취급. (설계 85) */
  isActive?: boolean;
  /** 카드 묶음 키(카드사·명의). 결제수단에만 있고, 체크·현금·선불은 없다. (설계 86) */
  groupKey?: string | null;
}

interface HhAdvancedProps {
  value: HhAdvancedFilter;
  onChange: (f: HhAdvancedFilter) => void;
  categories?: HhFilterOption[];
  methods?: HhFilterOption[];
  accounts?: HhFilterOption[];
}

const PRESET_LABEL: Record<RangePreset, string> = {
  thisMonth: "이번 달",
  lastMonth: "지난 달",
  last3Months: "최근 3개월",
  thisYear: "올해",
};

interface HhSearchBarProps {
  /** 기간 필터. 생략하면 기간(月) 행을 숨기고 키워드 검색만 표시한다(예: 대출관리). */
  range?: HhDateRange;
  onRangeChange?: (r: HhDateRange) => void;
  keyword: string;
  onKeywordChange: (v: string) => void;
  keywordPlaceholder?: string;
  /** 표시할 빠른 버튼(기본 이번달/지난달/최근3개월/올해) */
  quickPresets?: RangePreset[];
  /** 검색 버튼 클릭 시(선택). 목록은 실시간 필터라 보통 재조회 용도. */
  onSearch?: () => void;
  /** 초기화 시 되돌릴 기본 기간(기본 thisMonth) */
  defaultPreset?: RangePreset;
  /** 우측 확장 슬롯 */
  rightSlot?: ReactNode;
  /** 상세 필터(항목·결제수단·계좌/카드·금액범위) */
  advanced?: HhAdvancedProps;
  /** 컴팩트 모드(키워드 전용): 검색/초기화 버튼을 검색창과 한 줄로. 하단 버튼 행 생략. */
  compact?: boolean;
}

const selectClass = "h-9 rounded-lg border border-border/70 bg-background px-2.5 text-base md:text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30";
const labelClass = "w-14 shrink-0 text-sm font-semibold text-muted-foreground";

/**
 * 가계부 공통 검색 필터 카드 — DART(전자공시) 스타일. (설계 docs/household/30)
 * 라벨 그리드(기간/검색) + 빠른버튼 + 상세조건열기 + 검색/초기화 버튼.
 */
export function HhSearchBar({
  range,
  onRangeChange,
  keyword,
  onKeywordChange,
  keywordPlaceholder = "항목·가맹점·계좌로 검색",
  quickPresets = ["thisMonth", "lastMonth", "last3Months", "thisYear"],
  onSearch,
  defaultPreset = "thisMonth",
  rightSlot,
  advanced,
  compact = false,
}: HhSearchBarProps) {
  const [open, setOpen] = useState(false);
  // 모바일 상세 접기(설계 99 D) — 390px에서 조회바가 화면 절반을 차지해 목록이 안 보였다.
  // 접힘(기본): 기간 프리셋 + 키워드 검색 + 버튼만. 펼침: 날짜입력·항목·계좌/카드 추가 노출. md 이상은 항상 전체.
  const [mobileMore, setMobileMore] = useState(false);
  const showPeriod = Boolean(range && onRangeChange);

  const setField = (key: keyof HhAdvancedFilter, val: string) => {
    if (advanced) advanced.onChange({ ...advanced.value, [key]: val });
  };

  // 비활성 계좌·카드는 기본으로 감춘다 — 안 쓰는 게 목록의 3분의 1이라 고를 게 안 보인다. (설계 85)
  // 다만 과거 거래가 달려 있어(예: 옛 카드 이름 수천 건) 완전히 빼면 조회가 막히므로 토글로 되살린다.
  const [includeInactive, setIncludeInactive] = useState(false);
  const visibleOpts = (opts: HhFilterOption[] | undefined, selectedId: string) =>
    (opts ?? []).filter(
      // 이미 고른 항목은 감춤 대상이어도 남긴다 — 안 그러면 선택값이 목록에서 사라져 빈칸으로 보인다.
      (o) => includeInactive || o.isActive !== false || o.id === selectedId
    );
  const optLabel = (o: HhFilterOption) => (o.isActive === false ? `${o.name} (비활성)` : o.name);
  const inactiveCount =
    (advanced?.methods?.filter((m) => m.isActive === false).length ?? 0) +
    (advanced?.accounts?.filter((a) => a.isActive === false).length ?? 0);

  // 계좌/카드 = 결제수단(payment_method) + 계좌(account)를 한 드롭다운에 그룹으로 합친다. (설계 83)
  // 지출은 결제수단으로, 수입은 계좌로 식별되므로 값에 접두사를 붙여 어느 쪽인지 구분한다.
  const methodOpts = visibleOpts(advanced?.methods, advanced?.value.methodId ?? "");
  const accountOpts = visibleOpts(advanced?.accounts, advanced?.value.accountId ?? "");
  const hasMethods = methodOpts.length > 0;
  const hasAccounts = accountOpts.length > 0;
  const showSource = hasMethods || hasAccounts;
  const sourceLabel = hasMethods && hasAccounts ? "계좌/카드" : hasMethods ? "결제수단" : "계좌";
  // 카드 묶음(카드사·명의) 옵션 — 결제수단을 병합하지 않고 화면에서만 합쳐 고를 수 있게. (설계 86)
  // 묶음은 비활성 멤버(옛 통합카드)도 포함하므로 '비활성 숨김'(설계 85)과 무관하게 항상 보여준다.
  const cardGroups = useMemo(() => {
    const src = advanced?.methods ?? [];
    const map = new Map<string, string[]>();
    for (const m of src) {
      if (!m.groupKey) continue;
      map.set(m.groupKey, [...(map.get(m.groupKey) ?? []), m.id]);
    }
    // 멤버가 2장 이상일 때만 묶음으로 노출 — 1장짜리는 개별 항목과 중복이라 목록만 길어진다.
    return [...map.entries()]
      .filter(([, ids]) => ids.length >= 2)
      .map(([key, ids]) => ({ key, ids }))
      .sort((a, b) => a.key.localeCompare(b.key, "ko"));
  }, [advanced?.methods]);

  const sourceValue = advanced?.value.methodGroup
    ? `grp:${advanced.value.methodGroup}`
    : advanced?.value.methodId
      ? `pm:${advanced.value.methodId}`
      : advanced?.value.accountId
        ? `acct:${advanced.value.accountId}`
        : "";
  const setSource = (v: string) => {
    if (!advanced) return;
    const cleared = { methodId: "", accountId: "", methodIds: undefined, methodGroup: undefined };
    if (!v) advanced.onChange({ ...advanced.value, ...cleared });
    else if (v.startsWith("grp:")) {
      const key = v.slice(4);
      const ids = cardGroups.find((g) => g.key === key)?.ids ?? [];
      advanced.onChange({ ...advanced.value, ...cleared, methodIds: ids, methodGroup: key });
    } else if (v.startsWith("pm:")) advanced.onChange({ ...advanced.value, ...cleared, methodId: v.slice(3) });
    else advanced.onChange({ ...advanced.value, ...cleared, accountId: v.slice(5) });
  };

  // '상세조건' 버튼 활성 표시 = 접힌 안의 값(금액범위 · 비활성 포함)만 반영.
  // 항목·계좌/카드는 이제 밖에 보이므로 세지 않는다(세면 버튼이 늘 켜져 의미가 없다).
  const active = advanced ? hasAmountFilter(advanced.value) || includeInactive : false;

  // 초기화는 항상 기본 프리셋(당월)로 — 모든 검색창의 기간 기본값을 당월로 통일한다.
  const handleReset = () => {
    onRangeChange?.(presetRange(defaultPreset));
    onKeywordChange("");
    advanced?.onChange(EMPTY_ADVANCED_FILTER);
    setIncludeInactive(false);
  };

  const actionButtons = (
    <>
      <Button type="button" onClick={() => onSearch?.()}>
        <Search className="h-4 w-4" />
        검색
      </Button>
      <Button type="button" variant="outline" onClick={handleReset}>
        <RotateCcw className="h-4 w-4" />
        초기화
      </Button>
    </>
  );

  return (
    <div className={cn("rounded-2xl border border-border/70 bg-card/85 shadow-sm", compact ? "px-3 py-2.5 md:px-4 md:py-3" : "px-4 py-3 md:px-5")}>
      <div className="space-y-2.5">
        {/* 기간 (range 미지정 시 숨김) */}
        {showPeriod && range && onRangeChange ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className={cn(labelClass, "whitespace-nowrap")}>기간</span>
            {/* 모바일 접힘 상태에선 날짜 입력을 숨기고 프리셋만 — 펼치면 w-full 한 줄이라 "2026-07-0" 잘림도 없다. (설계 99 D)
                경계는 항목·계좌/카드·토글과 같은 md 하나로 통일 — sm이면 640~767px에서 일부만 펼쳐진 어중간한 상태가 된다(코드리뷰 지적). */}
            <div className={cn("w-full items-center gap-2 md:w-auto md:flex-none", mobileMore ? "flex" : "hidden md:flex")}>
              <div className="flex-1 sm:w-36">
                <DateInput value={range.start} onChange={(v) => onRangeChange({ ...range, start: v })} placeholder="시작일" />
              </div>
              <span className="text-muted-foreground">~</span>
              <div className="flex-1 sm:w-36">
                <DateInput value={range.end} onChange={(v) => onRangeChange({ ...range, end: v })} placeholder="종료일" />
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {quickPresets.map((p) => (
                <Button key={p} type="button" variant="outline" size="sm" onClick={() => onRangeChange(presetRange(p))}>
                  {PRESET_LABEL[p]}
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        {/* 항목 · 계좌/카드 · 검색 — 한 줄. 조건을 상시 노출하되 줄 수는 기간+검색 2줄로 유지한다. (설계 83) */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {advanced?.categories?.length ? (
            <div className={cn("items-center gap-2", mobileMore ? "flex" : "hidden md:flex")}>
              <span className="shrink-0 text-sm font-semibold text-muted-foreground">항목</span>
              <select
                aria-label="항목"
                className={cn(selectClass, "w-32")}
                value={advanced.value.categoryId}
                onChange={(e) => setField("categoryId", e.target.value)}
              >
                <option value="">전체</option>
                {advanced.categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          ) : null}
          {advanced && showSource ? (
            <div className={cn("items-center gap-2", mobileMore ? "flex" : "hidden md:flex")}>
              <span className="shrink-0 text-sm font-semibold text-muted-foreground">{sourceLabel}</span>
              {/* 폭 고정: native select 는 가장 긴 옵션('현대카드(이바다) 현대카드ZERO 할인형 하이패스')에
                  맞춰 늘어나 한 줄을 다 잡아먹는다. 닫힌 상태만 잘리고 목록은 전체가 보인다. */}
              <select
                aria-label={sourceLabel}
                className={cn(selectClass, "w-44")}
                value={sourceValue}
                onChange={(e) => setSource(e.target.value)}
              >
                <option value="">전체</option>
                {/* 그룹이 하나뿐이면 optgroup 없이 평평하게 — 불필요한 계층을 만들지 않는다. */}
                {hasMethods && hasAccounts ? (
                  <>
                    {cardGroups.length > 0 ? (
                      <optgroup label="카드 묶음 (카드사·명의)">
                        {cardGroups.map((g) => (
                          <option key={g.key} value={`grp:${g.key}`}>{g.key} 전체 ({g.ids.length}장)</option>
                        ))}
                      </optgroup>
                    ) : null}
                    <optgroup label="카드·결제수단">
                      {methodOpts.map((m) => (
                        <option key={m.id} value={`pm:${m.id}`}>{optLabel(m)}</option>
                      ))}
                    </optgroup>
                    <optgroup label="계좌">
                      {accountOpts.map((a) => (
                        <option key={a.id} value={`acct:${a.id}`}>{optLabel(a)}</option>
                      ))}
                    </optgroup>
                  </>
                ) : hasMethods ? (
                  <>
                    {cardGroups.length > 0 ? (
                      <optgroup label="카드 묶음 (카드사·명의)">
                        {cardGroups.map((g) => (
                          <option key={g.key} value={`grp:${g.key}`}>{g.key} 전체 ({g.ids.length}장)</option>
                        ))}
                      </optgroup>
                    ) : null}
                    {methodOpts.map((m) => (
                      <option key={m.id} value={`pm:${m.id}`}>{optLabel(m)}</option>
                    ))}
                  </>
                ) : (
                  accountOpts.map((a) => (
                    <option key={a.id} value={`acct:${a.id}`}>{optLabel(a)}</option>
                  ))
                )}
              </select>
            </div>
          ) : null}
          {/* 조건 셀렉트가 없으면(수집함 등) 기존처럼 '검색' 라벨을 붙인다. 있으면 라벨을 빼서 한 줄에 담는다. */}
          {advanced && (advanced.categories?.length || showSource) ? null : <span className={labelClass}>검색</span>}
          <div className="relative min-w-[10rem] flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={keyword} onChange={(e) => onKeywordChange(e.target.value)} placeholder={keywordPlaceholder} className="pl-10" />
          </div>
          {/* 모바일 전용: 접어둔 날짜입력·항목·계좌/카드 펼치기 토글. md 이상에선 항상 보이므로 버튼 자체를 숨긴다. (설계 99 D) */}
          {showPeriod || advanced ? (
            <Button type="button" variant={mobileMore ? "default" : "outline"} size="sm" className="md:hidden" onClick={() => setMobileMore((v) => !v)}>
              조건 {mobileMore ? "접기 ▲" : "더보기 ▼"}
            </Button>
          ) : null}
          {/* 접이식 = 금액범위 + 비활성 포함. 가끔 쓰는 것만 넣는다. */}
          {advanced ? (
            <Button type="button" variant={active ? "default" : "outline"} size="sm" onClick={() => setOpen((v) => !v)}>
              <SlidersHorizontal className="h-4 w-4" />
              상세조건 {open ? "▲" : "▼"}
            </Button>
          ) : null}
          {rightSlot}
          {/* 컴팩트 모드: 검색/초기화 버튼을 검색창과 같은 줄에 */}
          {compact ? <div className="flex gap-2">{actionButtons}</div> : null}
        </div>

        {/* 상세 필터 — 항목·계좌/카드는 위로 올렸고(설계 83), 가끔 쓰는 것만 남긴다. */}
        {advanced && open ? (
          <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border/50 bg-background/40 p-3">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              금액(이상)
              <Input type="number" inputMode="numeric" value={advanced.value.amountMin} onChange={(e) => setField("amountMin", e.target.value)} placeholder="0" className="w-28" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              금액(이하)
              <Input type="number" inputMode="numeric" value={advanced.value.amountMax} onChange={(e) => setField("amountMax", e.target.value)} placeholder="제한 없음" className="w-32" />
            </label>
            {/* 안 쓰는 계좌·카드 되살리기 — 옛 카드 이름에 과거 거래 수천 건이 달려 있어 조회 통로가 필요하다. (설계 85) */}
            {inactiveCount > 0 ? (
              <label className="flex h-9 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="h-4 w-4 cursor-pointer accent-primary"
                  checked={includeInactive}
                  onChange={(e) => setIncludeInactive(e.target.checked)}
                />
                안 쓰는 계좌·카드 {inactiveCount}개 포함
              </label>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* 검색 / 초기화 (컴팩트 모드는 위 검색줄에 붙였으므로 생략) */}
      {compact ? null : (
        <div className="mt-3 flex items-center justify-center gap-2 border-t border-border/50 pt-3">
          {actionButtons}
        </div>
      )}
    </div>
  );
}
