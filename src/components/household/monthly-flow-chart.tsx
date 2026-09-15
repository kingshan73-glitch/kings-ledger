// 연도별 월간 수입·지출·대출실행·대출상환 막대그래프 (설계 90 §2·§3, 설계 192)
//
// 요약 탭(올해 고정)과 연간 탭(연도 선택)이 **같은 컴포넌트를 두 번 호출**해서 쓴다.
// 통째로 요약으로 옮기면 연간 탭의 '연도를 넘겨 보는' 기능이 사라지므로 이렇게 공용화했다.
// 계산·색·축 포맷이 한 곳에 모여 있어 이후 수정도 한 번만 하면 된다.
"use client";

import { useCallback, useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { SectionIntro } from "@/components/page-shell";
import { useMasking } from "@/components/masking-provider";
import type { MaskCategory } from "@/lib/masking";
import { formatAmountInMan } from "@/lib/utils";
import { loanCategoryId, loanIncomeCategoryId, monthFlowTotals } from "@/lib/household/calc";
import { thisMonthKey } from "@/lib/household/month";
import type { HhCategory, HhInstallment, HhTransaction } from "@/lib/household/types";

/**
 * 색 규율(설계 80)의 파랑=수입은 유지하되, 수입·지출·대출 계열이 한눈에 갈리도록 색상(hue)을 나눈다
 * (팀장 지시 2026-08-26, 설계 189·192). 예전엔 지출 `#94a3b8`·대출 `#64748b` 로 같은 회색의 명도만 달라
 * 막대만 보고는 어느 쪽인지 분간이 안 됐다.
 * 대출실행·대출상환은 같은 보라 계열의 명도 차이로 돈의 방향을 구분한다. 실행은 violet-400 `#a78bfa` —
 * 처음 쓴 `#c4b5fd` 는 라이트 모드 카드 배경 대비 1.85:1 이라 막대·범례 점이 흐렸다(2026-08-27 검토).
 * 지출의 호박색은 이 앱에서 이미 '나가는 돈'(현금흐름 '카테고리별 출금 예정' 막대)에 쓰던 색이다.
 */
const FLOW_COLORS = { income: "#3182f6", expense: "#f59e0b", loanIn: "#a78bfa", loan: "#7c3aed" };
/** 범례·막대 순서 — 팀장 지시: 수입 → 지출 → 대출실행 → 대출상환. */
const FLOW_SERIES = [
  { key: "수입", color: FLOW_COLORS.income },
  { key: "지출", color: FLOW_COLORS.expense },
  { key: "대출실행", color: FLOW_COLORS.loanIn },
  { key: "대출상환", color: FLOW_COLORS.loan },
] as const;

function won(n: number) {
  return `${n.toLocaleString("ko-KR")}원`;
}

/**
 * 좁은 막대 위에 세로로 붙이는 짧은 금액. 공용 `formatAmountInMan`은 0도 `0원`으로 표시하고
 * 억 단위를 줄이지 않으며 `만원` 접미사를 쓰므로, 라벨 요구 형식에는 전용 포맷터가 더 알맞다.
 * 1만원 미만은 단위를 생략하지 않고 원 단위 숫자만, 음수는 부호를 보존해 같은 절댓값 규칙으로 쓴다.
 */
export function shortWon(n: number): string {
  if (n === 0) return "";

  const sign = n < 0 ? "-" : "";
  const amount = Math.abs(n);
  // ★반올림한 뒤에 단위를 다시 고른다 — 9,999.5 를 원 단위로 반올림하면 10,000 이라 "1만"이어야 하고,
  //   99,995,000 을 만 단위로 반올림하면 10,000만 이라 "1억"이어야 한다(덱스 검토 2026-08-28 Low).
  const won = Math.round(amount);
  if (won < 10_000) return `${sign}${won.toLocaleString("ko-KR")}`;
  const man = Math.round(amount / 10_000);
  if (man < 10_000) return `${sign}${man.toLocaleString("ko-KR")}만`;

  const eok = Math.round((amount / 100_000_000) * 10) / 10;
  return `${sign}${eok.toLocaleString("ko-KR")}억`;
}

interface Props {
  year: string;
  txns: HhTransaction[];
  installments: HhInstallment[];
  categories: HhCategory[];
  /** 섹션 제목·설명을 이 컴포넌트가 그릴지 여부. 연간 탭은 자체 제목을 쓰므로 false. */
  withHeading?: boolean;
}

export function MonthlyFlowChart({ year, txns, installments, categories, withHeading = true }: Props) {
  const { mask, enabled: maskEnabled } = useMasking();

  const maskNum = useCallback(
    (n: number, cat: MaskCategory = "expense_amount") => {
      if (!maskEnabled) return n;
      const digits = mask(cat, String(Math.round(n))).replace(/[^\d]/g, "");
      return digits ? Number(digits) : 0;
    },
    [maskEnabled, mask]
  );

  // ★1~12월을 항상 그린다(팀장 지시 2026-08-26, 설계 189). 예전엔 진행 중인 연도를 당월까지만 잘라
  //   그렸다 — "아직 오지 않은 달을 0으로 그리면 급감처럼 보인다"는 이유였는데, 팀장은 한 해 전체
  //   눈금 위에서 지금 어디까지 왔는지를 보고 싶어 한다. 오지 않은 달은 아래 안내 문구로 구분한다.
  const months = useMemo(
    () => Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`),
    [year]
  );

  const loanCatId = useMemo(() => loanCategoryId(categories), [categories]);
  const loanIncomeCatId = useMemo(() => loanIncomeCategoryId(categories), [categories]);

  /** 마스킹 전 원본 합계. ★'데이터가 있나' 판정은 반드시 이 쪽으로 한다 — 아래 주석 참고. */
  const raw = useMemo(
    () => months.map((ym) => monthFlowTotals(ym, txns, installments, loanCatId, loanIncomeCatId)),
    [months, txns, installments, loanCatId, loanIncomeCatId]
  );

  const data = useMemo(
    () =>
      months.map((ym, i) => ({
        name: `${Number(ym.slice(5, 7))}월`,
        수입: maskNum(raw[i].income, "income_amount"),
        지출: maskNum(raw[i].expense),
        대출실행: maskNum(raw[i].loanIn, "income_amount"),
        대출상환: maskNum(raw[i].loan),
      })),
    [months, raw, maskNum]
  );

  // ★`empty`·대출 계열 표시는 마스킹된 `data` 가 아니라 원본 `raw` 로 판정한다 (설계 189·192).
  //   마스킹은 금액을 무작위 값으로 바꾸므로 마스킹된 값으로 "0인가"를 물으면 언제나 아니라고 답한다.
  //   (masking.ts 에서 0 보존을 넣어 지금은 0 이 0 으로 남지만, 판정을 마스킹에 의존시키지 않는다 —
  //    마스킹 규칙이 또 바뀌면 이 그래프가 조용히 거짓말을 하게 된다.)
  const empty = raw.every((f) => f.income === 0 && f.expense === 0 && f.loanIn === 0 && f.loan === 0);

  // 대출 상환 분류(설계 90 §1)는 올해분만 해 두었다. 분류가 없는 과거 연도는 대출이 전부 0으로 나오는데,
  // 이걸 막대로 그리면 '한 푼도 안 갚은 해'처럼 보인다 — 데이터 없음을 0으로 그리지 않고 계열을 뺀다.
  const hasLoan = raw.some((f) => f.loan > 0);
  const hasLoanIn = raw.some((f) => f.loanIn > 0);
  const visibleSeriesCount = 2 + Number(hasLoanIn) + Number(hasLoan);
  const barSize = visibleSeriesCount === 4 ? 8 : visibleSeriesCount === 3 ? 10 : 12;
  const isCurrentYear = year === thisMonthKey().slice(0, 4);

  const description =
    // ★"뒷달은 빈칸"이라고 단정하지 않는다 — 미래 날짜로 등록된 거래·할부가 있으면 실제로 막대가 선다
    //   (조회가 내년 1월까지 가져온다). 없는 것을 없다고만 말하도록 문구를 고쳤다(설계 189).
    (isCurrentYear ? `1~12월 눈금 위에 ${Number(thisMonthKey().slice(5, 7))}월까지 채워집니다(뒷달은 미리 등록해 둔 거래가 없으면 빈칸). ` : `${year}년 한 해의 흐름입니다. `) +
    // ★필터가 실제로 걸릴 때만 걸렸다고 말한다 (교차검토 2026-08-26, 설계 190 §4).
    //   예전엔 이 문장이 무조건 나와서, 수입 카테고리 '대출'이 없거나 이름이 바뀌면
    //   **필터가 안 걸린 숫자 옆에서 걸렸다고 주장**했다 — 조용한 실패보다 나쁘다.
    (loanIncomeCatId
      ? "수입은 번 돈만 세고 대출 실행금(빌린 돈)은 뺍니다. "
      : "※ 수입 카테고리 ‘대출’을 못 찾아 대출 실행금이 수입에 그대로 들어 있습니다. ") +
    // 아래 '이번 달 수입·소비지출' 카드는 이제 **같은 함수**를 쓴다(팀장 판정 2026-08-26 — 기준 통일).
    // 다만 '최근 3개월 항목별 지출'·예산 초과·전월 대비 급증은 **카테고리별 분석**이라 할부를 매달 나눠 센다
    // — 한 달에 총액을 몰면 그 항목만 튀어 비교가 무의미해지기 때문이다. 그 차이를 여기서 밝힌다.
    "지출은 결제한 달 기준으로 할부도 쪼개지 않고 결제월에 총액으로 넣습니다(아래 ‘소비지출’ 카드와 같은 잣대입니다. 단 ‘최근 3개월 항목별 지출’·예산·급증 알림은 항목별 비교라 할부를 매달 나눠 셉니다). 카드대금은 카드로 쓸 때 이미 지출로 잡혀 있어 넣지 않습니다." +
    // ★각 계열은 자기 플래그 아래서만 설명한다 — 안 그리는 계열을 설명하면 "필터가 걸렸다"고
    //   거짓말하던 설계 190 §4 와 같은 유형의 조용한 실패다(2026-08-27 검토 지적).
    (hasLoanIn ? " 대출실행은 그달 빌린 돈(수입에서 뺀 금액과 같습니다). 세로 눈금은 모든 계열이 함께 쓰므로 실행금이 큰 달에 맞춰집니다. 납작해진 막대는 위에 적힌 금액으로 읽으세요." : "") +
    (hasLoan ? " 대출상환은 갚은 원리금(부채 감소)이라 지출과 겹치지 않습니다." : "");

  return (
    <section className="space-y-3">
      {withHeading ? <SectionIntro title={`${year}년 월별 수입·지출${hasLoan || hasLoanIn ? "·대출" : ""}`} description={description} /> : null}
      {empty ? (
        <div className="rounded-2xl border border-dashed border-border/70 bg-background/40 p-10 text-center">
          <p className="text-sm text-muted-foreground">{year}년 거래가 없습니다.</p>
        </div>
      ) : (
        <div className="rounded-2xl border border-border/70 bg-card/85 p-4 shadow-sm">
          {/* ★수입 필터가 죽었으면 숫자를 그대로 믿으면 안 된다 — 설명글에 묻지 말고 차트 바로 위에 띄운다
              (교차검토 2026-08-26, 설계 190 §4). 이 카테고리는 기본 시드(defaults.ts·import_household_excel.py)에
              **없고 팀장이 손으로 만든 것 하나뿐**이라, 이름만 바꿔도 필터가 조용히 무력화된다. */}
          {!loanIncomeCatId ? (
            <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-200/70 bg-amber-50/80 px-3 py-2 dark:border-amber-900/40 dark:bg-amber-950/20">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                대출 실행금이 수입에 섞여 있습니다.
                <span className="ml-1 font-normal text-amber-700/80 dark:text-amber-300/80">
                  수입 카테고리 ‘대출’을 찾지 못했습니다 — 설정에서 이름이 바뀌었는지 확인해 주세요.
                </span>
              </p>
            </div>
          ) : null}
          {/* 분류가 안 된 해는 숫자를 그대로 믿으면 안 된다 — 설명글에 묻지 말고 차트 바로 위에 띄운다(팀장 지시 2026-07-19). */}
          {!hasLoan ? (
            <div className="mb-3 flex items-start gap-2 rounded-xl border border-amber-200/70 bg-amber-50/80 px-3 py-2 dark:border-amber-900/40 dark:bg-amber-950/20">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                미분류건 미적용으로인해 정확한 데이터는 아닙니다.
                <span className="ml-1 font-normal text-amber-700/80 dark:text-amber-300/80">
                  대출 상환 거래 분류가 올해분만 되어 있어 {year}년은 대출상환을 표시하지 않습니다.
                </span>
              </p>
            </div>
          ) : null}
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 44, right: 8, bottom: 0, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" fontSize={11} interval={0} />
                <YAxis tickFormatter={(v) => formatAmountInMan(Number(v))} fontSize={11} width={48} />
                <Tooltip formatter={(value) => won(Number(value))} />
                {/* LabelList는 Bar가 받은 `data`(이미 마스킹된 값)를 기본값으로 읽는다. 원본 `raw`를 넘기지 않는다.
                    Recharts 3.7은 className을 각 SVG <text>에 전달하므로 Tailwind lg 미디어 쿼리로 1024px 미만에서는 숨긴다
                    (768~856px 는 막대 간격 8px < 글자 9px 라 같은 달 라벨이 1px 겹친다 — 덱스 검토 2026-08-28).
                    ★angle=-90 만 주면 회전 중심이 막대 꼭대기라 글자 절반이 막대 위로 내려온다(2026-08-28 실화면) —
                    textAnchor=start 로 기준점에서 위로만 뻗게 한다(verticalAnchor 는 LabelList 타입에 없다). */}
                <Bar dataKey="수입" fill={FLOW_COLORS.income} barSize={barSize}>
                  <LabelList className="hidden lg:block" position="top" angle={-90} textAnchor="start" offset={4} fontSize={9} fill={FLOW_COLORS.income} formatter={(value) => shortWon(Number(value))} />
                </Bar>
                <Bar dataKey="지출" fill={FLOW_COLORS.expense} barSize={barSize}>
                  <LabelList className="hidden lg:block" position="top" angle={-90} textAnchor="start" offset={4} fontSize={9} fill={FLOW_COLORS.expense} formatter={(value) => shortWon(Number(value))} />
                </Bar>
                {hasLoanIn ? (
                  <Bar dataKey="대출실행" fill={FLOW_COLORS.loanIn} barSize={barSize}>
                    <LabelList className="hidden lg:block" position="top" angle={-90} textAnchor="start" offset={4} fontSize={9} fill={FLOW_COLORS.loanIn} formatter={(value) => shortWon(Number(value))} />
                  </Bar>
                ) : null}
                {hasLoan ? (
                  <Bar dataKey="대출상환" fill={FLOW_COLORS.loan} barSize={barSize}>
                    <LabelList className="hidden lg:block" position="top" angle={-90} textAnchor="start" offset={4} fontSize={9} fill={FLOW_COLORS.loan} formatter={(value) => shortWon(Number(value))} />
                  </Bar>
                ) : null}
              </BarChart>
            </ResponsiveContainer>
          </div>
          {/* ★범례를 직접 그린다 — recharts 의 <Legend> 는 계열 등록 순서대로 그려 '대출·수입·지출'처럼
              뒤섞여 나왔고(팀장 지적 2026-08-26, 설계 189), 이 버전은 순서를 잡을 `payload` prop 을 받지 않는다.
              막대 순서와 같은 수입 → 지출 → 대출실행 → 대출상환으로 고정한다. 안 그리는 계열은 범례에서도 뺀다. */}
          <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {FLOW_SERIES.filter(
              (s) => (s.key !== "대출실행" || hasLoanIn) && (s.key !== "대출상환" || hasLoan)
            ).map((s) => (
              <span key={s.key} className="inline-flex items-center gap-1.5">
                <span aria-hidden className="size-2.5 rounded-[2px]" style={{ backgroundColor: s.color }} />
                {s.key}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
