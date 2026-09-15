"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Fragment, useCallback, useMemo, useState, type ReactNode } from "react";

import { ErrorState, LoadingState } from "@/components/page-shell";
import { cn } from "@/lib/utils";

export interface HhBoardColumn<T> {
  key: string;
  header: string;
  align?: "left" | "center" | "right";
  /** 헤더/셀 공통 추가 클래스(정렬·색 등). ★폭은 여기 넣지 말고 width 를 쓴다. (설계 122) */
  className?: string;
  /**
   * 열 폭(px) — **`HH_COL` 척도에서만 고른다**. (설계 122)
   * 생략하면 가변 텍스트 열로 보고 기준폭 HH_COL_FLEX_MIN 을 쓴다.
   * 어느 쪽이든 남는 폭은 colStyles() 가 **전 열에 똑같이** 얹는다 — 그래야 간격이 균일하다.
   */
  width?: number;
  cell: (row: T, rowNumber: number) => ReactNode;
  /**
   * 표 맨 아래 집계행(합계 등) 셀. 어느 한 컬럼이라도 지정하면 tfoot(모바일은 합계 카드)이 렌더된다.
   * 인자는 (페이지 무관) 현재 필터/정렬된 전체 행이다 — 상단 요약카드와 합이 일치한다.
   */
  footer?: (rows: T[]) => ReactNode;
  /**
   * 모바일 카드 압축 힌트(설계 99 E). 어느 한 컬럼이라도 지정하면 그 보드의 모바일 카드는
   * "1행 = title↔amount(굵게) / 2행 = meta 나열(라벨 없이 · 구분)"로 압축된다 — 카드 높이 절반.
   * 아무 컬럼도 지정하지 않은 보드는 기존 라벨:값 세로 나열 그대로(하위호환).
   */
  mobile?: "title" | "amount" | "meta" | "hide";
}

export interface HhBoardSort<T> {
  key: string;
  label: string;
  cmp: (a: T, b: T) => number;
}

interface HhBoardProps<T> {
  rows: T[];
  columns: HhBoardColumn<T>[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** 번호 열 표시(기본 true) */
  numbered?: boolean;
  /** 정렬 규칙 목록. 첫 번째가 기본 정렬이다. */
  sorts?: HhBoardSort<T>[];
  /**
   * **헤더를 눌러 정렬을 바꿀 수 있게 한다**(기본 false). (설계 134, 팀장 지시 2026-08-04)
   *
   * ★opt-in 인 이유: 예전엔 `sorts` 를 넘겨도 **첫 번째 규칙이 그냥 고정**이라 나머지는 코드에만 있고
   *   화면에서 못 골랐다. 그렇다고 전 화면에 한꺼번에 켜면, 날짜로 묶어 보여주는 표(지출 — `groupBy`)는
   *   금액순으로 정렬하는 순간 날짜 구분줄이 깨지고 되돌릴 열도 없다. 그래서 표별로 켠다.
   * 정렬 키가 **열 key 와 같을 때만** 그 헤더가 눌린다(`sorts[].key` ↔ `columns[].key`).
   */
  sortable?: boolean;
  /**
   * 한 페이지 행 수(기본 15).
   * **`null` 이면 페이지를 나누지 않고 전체를 한 화면에 보여준다**(페이지네이션 버튼도 사라진다).
   * 행이 수십 건을 넘지 않고 전부 나란히 놓고 봐야 뜻이 있는 표에서 쓴다 — 대출관리(팀장 지시 2026-08-02).
   */
  pageSize?: number | null;
  /**
   * 2단 보기(설계 145): 한 페이지에 `pageSize`×2 행을 담되 **왼쪽=앞 페이지, 오른쪽=다음 페이지**로
   * 나란히 그린다. 표가 페이지 폭의 절반만 쓰는 화면(지출 592px vs 가용 1200px)에서 남는 오른쪽을
   * 쓰고 페이지 넘김을 절반으로 줄인다. 정렬 상태는 이 컴포넌트가 쥐고 있어 **어느 쪽 머리를 눌러도
   * 전체가 정렬**된다(두 표를 따로 만들면 안 되는 이유).
   */
  twoUp?: boolean;
  emptyText?: string;
  /** 빈 상태에서 보여줄 다음 행동(등록 버튼 등). 검색 결과 빈 상태에는 넘기지 않는 것을 권장. */
  emptyAction?: ReactNode;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  /**
   * 표 최소 폭 override(px). 보통 넘기지 않는다 — 컬럼의 width 로 자동 계산된다. (설계 122)
   * 계산값이 과해 가로 스크롤이 불필요하게 생기는 표에서만 근거와 함께 쓴다.
   */
  minWidth?: number;
  /** 상단 '전체 N건' 헤더 표시(기본 true). 탭 배지 등으로 건수가 이미 보이면 false로 중복 제거. */
  showCount?: boolean;
  /**
   * 연속된 행을 같은 키로 묶어 구분줄(날짜 헤더 등)을 넣는다. (설계 80)
   * 정렬이 키 순서와 일치할 때 쓴다(불일치하면 그룹이 조각남).
   * render의 rows에는 페이지와 무관하게 그 키의 전체 행이 넘어온다(일 합계 등 계산용).
   */
  groupBy?: {
    key: (row: T) => string;
    render: (key: string, rows: T[]) => ReactNode;
  };
}

const alignClass = { left: "text-left", center: "text-center", right: "text-right" } as const;

/**
 * 컬럼 폭 척도 — 내용 종류별 고정 px. (설계 122, 팀장 지시 2026-08-01 6차)
 *
 * ★규칙이 바뀌었다: 예전(설계 120·121)의 "전 컬럼 100/n% 균등"은 **폐기**다.
 *   팀장이 보는 것은 열 폭이 아니라 **화면에 칠해진 내용 사이의 여백**이다.
 *   열을 같게 하면 날짜(44px)·체크박스(16px) 옆에만 130~160px 공백이 남아 오히려 들쭉날쭉해진다.
 *
 * 쓰는 법
 *   - 최대 길이가 예측되는 열 → 아래 척도에서 고른다.
 *   - 길이를 예측할 수 없는 텍스트 열(항목명·계좌명·메모) → **폭을 주지 않는다**(기준폭 160).
 *   - 척도에 없는 px 를 직접 적지 않는다. 새 종류가 필요하면 여기에 키를 추가하고 근거를 적는다
 *     (표마다 제각각인 px 가 다시 쌓이는 걸 막는 유일한 장치다).
 *
 * ★값은 전부 **실측**이다 — `npx tsx scripts/measure_table_content.mts` 로 화면을 그려
 *   열별 ink(칠해지는 영역) 최대폭 + 좌우 패딩 32px 를 잰 뒤, 16px 격자에 올려 잡았다.
 *   추측으로 px 를 적으면 헤더가 잘리거나 공백이 남는다(6차 지적의 원인이 정확히 그것이었다).
 *   슬랙은 최대 15px — 열마다 130~250px 씩 벌어지던 이전 상태와는 차원이 다르다.
 *
 * 슬롯이 크기순인 것은 의도적이다. 이름을 내용별로 쪼개면(dateShort/badge/…) 같은 px 에
 * 이름만 여럿 생겨 어느 걸 쓸지가 매번 논쟁거리가 된다. **필요폭 이상인 가장 작은 슬롯**을 고른다.
 */
export const HH_COL = {
  /** 56 — 번호(1~9999) */
  num: 56,
  /** 64 — 체크박스·아이콘 1개(실측 60.0) · 3글자 헤더의 하한(‘상환일’ 61.2) */
  icon: 64,
  /** 72 — 4글자 헤더가 한 줄에 들어가는 하한(‘표시순서’ 70.9). 내용은 짧은 숫자·기호. */
  tight: 72,
  /** 88 — 짧은 텍스트·배지: 진행·종료예정·상태·명의·종류·방향·주기·납부일·이자율 (실측 필요 44.2~79.9) */
  short: 88,
  /**
   * 112 — 이 표들의 주력 슬롯. 날짜 `2026-08-01`(실측 95.8~97.5) · 금액·잔액(89.8~103.3) ·
   * 카테고리 배지(103.3) · 화살표 있는 짧은 select(101) · 긴 헤더('결제방식' 83, '전체 결제금액' 93).
   */
  standard: 112,
  /** 136 — 자릿수 큰 금액·긴 라벨: 대출 잔액(실측 118.2) · 대출금액(115) · 결제수단명(129.7) */
  wide: 136,
  /**
   * 160 — 두 뜻을 슬래시로 겹쳐 쓴 긴 헤더용. '출금금액 / 결제금액'(실측 152)이 136 에서
   * 두 줄로 꺾여 '액' 한 글자만 떨어졌다(검사기는 못 보고 스크린샷에서 잡음 — 그래서 E 검사를 넣었다).
   * 가변 텍스트 열의 기준폭(HH_COL_FLEX_MIN)과 같은 값이다.
   */
  xwide: 160,
  /**
   * 208 — 사람이 지은 긴 이름이 들어가는 열(정기지출 '항목'). (설계 123)
   * 실측(2026-08-02, 현금흐름 고유 항목 39개): 중앙값 134 · 75% 146 · **90% 172** · 최대 251.
   * 208(안쪽 178)이면 상위 90%까지 한 줄에 들어간다. 최대치(251)에 맞춰 281 로 잡으면
   * 표가 1232px 이 되어 **페이지 최대폭 1200px 을 넘겨** 모든 화면에서 가로 스크롤이 생긴다 —
   * 그래서 폭은 90% 에 맞추고, 넘치는 소수는 자르지 않고 **줄바꿈**으로 푼다(아래 HH_CELL.wrapText).
   */
  xxwide: 208,
  /**
   * 240 — 긴 이름 **옆에 배지까지** 들어가는 열. (설계 125)
   * 익월 출금 '항목'이 그렇다: 아이콘 16 + 이름 125 + '입력함' 배지 45 + 간격 = 198 이 필요해
   * 208(안쪽 178)에서 이름이 두 줄로 꺾였다. 배지가 없는 당월 표는 208 로 충분하다 —
   * ★같은 이름의 열이라도 **그 표에 실제로 들어가는 것**을 재서 각자 잡는다.
   */
  x3wide: 240,
  /**
   * 272 — 이 표의 **가장 긴 값 하나**를 위해 필요한 폭. (설계 125)
   * 설정 '이름'이 그렇다: '현대카드(이바다) 현대카드ZERO 할인형 하이패스'(235)가 208 에서 꺾였다.
   * ★쓰기 전에 표 폭 합계가 페이지 최대폭(1200)을 넘지 않는지 반드시 계산할 것 — 이 표는 1192 다.
   */
  x4wide: 272,
} as const;

/** 폭을 안 준(가변 텍스트) 열의 기준 폭. 계좌명·가맹점명이 읽히는 최소치다. (설계 122) */
export const HH_COL_FLEX_MIN = 160;

/** 열들의 기준 폭 합 = 그 표의 최소 폭(px). 이보다 좁아지면 껍데기가 가로 스크롤을 만든다. */
export function tableMinWidth(widths: (number | undefined)[]): number {
  return widths.reduce<number>((s, w) => s + (w ?? HH_COL_FLEX_MIN), 0);
}

/**
 * <col> 에 넣을 폭 스타일 = 척도 폭 그대로. (설계 122)
 *
 * ★표를 늘리지 않는 것이 이 규칙의 핵심이다. 두 번 헛짚고 나서야 알았다:
 *   ① 고정폭 열만 척도로 주고 나머지를 비워 두면 → **가변 열이 남는 폭을 혼자 다 먹는다**
 *      (1920px 실측: 인물 표 '이름' 뒤 902.9px, 나머지 경계는 30~80px).
 *   ② 남는 폭을 전 열에 똑같이 나눠 얹어도 안 된다 → **정렬이 섞이면 무너진다.**
 *      간격 = 그 열의 폭 − 내용폭 인데, 우측정렬 숫자는 내용이 오른쪽 끝에 붙어 간격이 32px 로
 *      작아지고(예산 표 마지막 경계 30px), 좌측정렬 짧은 텍스트는 얹은 몫만큼 커진다(346px).
 *   → **남는 폭 자체를 만들지 않는다.** 표 폭 = 척도 폭의 합.
 *      그러면 모든 경계가 `열폭 − 내용폭` = 패딩 32px + 슬롯 슬랙(≤24px) 로 수렴한다.
 *
 * 표가 카드보다 좁아지면 껍데기(shell)도 같이 줄어든다(`w-fit`) — 표만 덩그러니 뜨지 않는다.
 * (Tailwind JIT 는 런타임 계산 클래스를 못 보므로 클래스가 아니라 인라인 style 이어야 한다.)
 */
export function colStyles(widths: (number | undefined)[]): { width: number }[] {
  return widths.map((w) => ({ width: w ?? HH_COL_FLEX_MIN }));
}

/**
 * 게시판 표 룩 단일 출처. (설계 30 / 80)
 * HhBoard를 못 쓰는 화면(설정 탭처럼 행에 수정·삭제 버튼이 필요한 표)도 이 상수를 그대로 써서
 * 폰트·행높이·열너비가 공용 게시판과 어긋나지 않게 한다. 예전엔 각자 복붙해 py-3/py-2로 갈라졌었다.
 */
export const HH_TABLE = {
  /** 표 바깥 껍데기(둥근 테두리·카드 배경) */
  shell: "w-fit max-w-full overflow-x-auto rounded-2xl border border-border/70 bg-card/85 shadow-sm",
  /**
   * <table> — tableMinWidth() 로 계산한 인라인 minWidth 와 함께 쓴다.
   * ★table-fixed 필수: 없으면 <col> 에 준 폭이 '희망사항'이 되고 내용 긴 열이 남는 폭을 먹는다.
   *   (2026-08-01 실측 — 대출 표는 폭 선언이 없어 대출명 169.8px / 이자율 126.2px 로 벌어져 있었다.)
   *   폭은 반드시 colStyles() 로 만든 <colgroup> 에서 준다. 검사: npm run test:table-render
   */
  table: "table-fixed text-[0.8rem]",
  // ⚠️ 표 최소폭 상수는 두지 않는다. 손으로 적은 값은 고정폭 합을 넘는 순간 가변 열을 0px 로
  //    눌러 버린다 — 반드시 `tableMinWidth(cols)` 로 계산해 인라인 style 로 준다. (설계 122)
  /** 헤더 <tr> */
  headRow: "border-b-2 border-border bg-muted/50 text-xs font-semibold text-muted-foreground",
  /** 헤더 <th> */
  th: "px-4 py-2",
  /** 본문 <tr> */
  row: "border-b border-border/40 last:border-0 transition-colors",
  /** 본문 <td> */
  td: "px-4 py-1",
  /** 집계(합계) <tr> */
  footRow: "border-t-2 border-border bg-muted/40 text-[0.8rem] font-semibold text-foreground",
  /** 집계 <td> */
  footTd: "px-4 py-2",
} as const;

/**
 * 셀 안 **텍스트를 자르지 않는다** — 안 들어가면 줄바꿈한다. (설계 123, 팀장 지시 2026-08-02)
 *
 * ★`truncate` 를 쓰지 마라. 예전 규칙(설계 120)은 "잘림은 truncate+title 로 푼다"였는데,
 *   그건 **화면에서 글자가 사라진다**는 뜻이다(팀장 지적: "현금흐름 항목이 잘려 나온다").
 *   title 툴팁은 마우스를 올려야 보이므로 **표를 훑어볼 때는 없는 것과 같다.**
 *
 * 왜 폭을 넓히는 것만으로는 못 푸는가: 항목명 길이는 사람이 짓는 값이라 상한이 없다.
 *   현금흐름 최대치(251px)에 맞추면 표가 페이지 최대폭 1200px 을 넘는다(실측).
 *   → **폭은 상위 90% 에 맞추고(HH_COL.xxwide), 넘치는 소수는 줄바꿈**으로 흘린다.
 *      그러면 폭이 얼마든·데이터가 무엇이든 잘림이 0 이 된다.
 *
 * ★`break-words` 를 같이 주지 마라 — **`anywhere` 를 덮어써서 죽인다.** Tailwind v4 가 유틸리티를
 *   `[overflow-wrap:anywhere]` → `.break-words` 순으로 출력하는데 둘 다 명시도가 같아 **뒤에 나온
 *   `break-word` 가 이긴다**(className 나열 순서와 무관). 실측: 계산값이 `break-word` 로 나온다.
 *   차이가 나는 곳은 **flex 안**이다 — `break-word` 는 min-content 를 줄이지 않아, 공백 없는 긴 토큰
 *   (영문 가맹점명·하이픈 없는 계좌번호·URL)이 있으면 flex 아이템이 안 줄고 **옆 칸 위에 겹쳐 그려진다**
 *   (실측 +131px). `anywhere` 만 줘야 제대로 꺾인다. (교차리뷰 지적 2026-08-02)
 * 이 클래스를 쓰는 셀에는 `whitespace-nowrap` 을 같이 주지 마라 — 줄바꿈이 막혀 도로 잘린다.
 */
export const HH_CELL = {
  /** 길이를 예측할 수 없는 텍스트(항목명·계좌명·사유). truncate 대신 이걸 쓴다. */
  wrapText: "[overflow-wrap:anywhere]",
} as const;

/**
 * 가계부 공용 게시판 테이블 — DART(전자공시) 스타일. (설계 docs/household/30)
 * 조회건수·정렬 툴바 + 번호열 + 중앙정렬·테두리 헤더 + 페이지네이션을 한 번에 제공.
 * 컬럼 정의(cell 렌더)만 화면별로 넘기면 룩을 일관되게 통일한다.
 */
export function HhBoard<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  numbered = false,
  sorts,
  sortable = false,
  pageSize: pageSizeProp = 15,
  twoUp = false,
  emptyText = "표시할 항목이 없습니다.",
  emptyAction,
  loading = false,
  error = false,
  onRetry,
  minWidth,
  showCount = true,
  groupBy,
}: HhBoardProps<T>) {
  const [page, setPage] = useState(0);
  // 기본은 sorts[0]. sortable 인 표에서는 헤더 클릭으로 바뀐다. (설계 134)
  const [sortKey, setSortKey] = useState(sorts?.[0]?.key ?? "");
  // 각 cmp 는 자기 자연 방향(대개 큰 순·이른 날짜순)을 갖는다 — 같은 헤더를 다시 누르면 뒤집는다.
  const [reversed, setReversed] = useState(false);

  const sorted = useMemo(() => {
    const s = sorts?.find((x) => x.key === sortKey) ?? sorts?.[0];
    if (!s) return rows;
    const out = [...rows].sort(s.cmp);
    return reversed ? out.reverse() : out;
  }, [rows, sorts, sortKey, reversed]);

  /** 그 열이 눌러서 정렬할 수 있는 열인가(정렬 키와 열 key 가 같을 때만). */
  const sortOf = (colKey: string) => (sortable ? sorts?.find((s) => s.key === colKey) : undefined);
  const toggleSort = (colKey: string) => {
    setPage(0); // 정렬이 바뀌면 1페이지부터 — 안 그러면 빈 페이지가 보인다
    if (sortKey === colKey) setReversed((v) => !v);
    else {
      setSortKey(colKey);
      setReversed(false);
    }
  };

  const total = sorted.length;
  // pageSize=null(전체 보기)이면 한 페이지에 전부 담는다. 0 건이어도 slice 가 깨지지 않게 최소 1.
  // ★Math.max(1, …) 로 0·음수를 봉인한다 — 0 이 들어오면 totalPages 가 Infinity 가 되고 slice 가
  //   빈 배열이라, 데이터가 있는데도 "표시할 항목이 없습니다" 로 조용히 실패한다.
  const pageSize = Math.max(1, pageSizeProp ?? total);
  // 2단이면 한 번에 두 페이지분을 담는다(왼쪽 pageSize + 오른쪽 pageSize). 설계 145
  const viewSize = twoUp ? pageSize * 2 : pageSize;
  const totalPages = Math.max(1, Math.ceil(total / viewSize));
  const safePage = Math.min(page, totalPages - 1);
  const rowBase = safePage * viewSize;
  const pageRows = sorted.slice(rowBase, rowBase + viewSize);
  // ★자르는 지점은 절반이 아니라 `pageSize` 다 — 왼쪽이 '1페이지', 오른쪽이 '2페이지'여야
  //   행이 몇 개든 왼쪽 분량이 일정하다(절반으로 자르면 마지막 장에서 좌우가 들쭉날쭉해진다).
  // ★useMemo 로 감싼다 — 매 렌더마다 새 배열이면 아래 buildSegments 의 useMemo 가 늘 다시 돈다.
  const leftRows = useMemo(() => (twoUp ? pageRows.slice(0, pageSize) : pageRows), [twoUp, pageRows, pageSize]);
  const rightRows = useMemo(() => (twoUp ? pageRows.slice(pageSize) : []), [twoUp, pageRows, pageSize]);
  const colCount = columns.length + (numbered ? 1 : 0);
  const hasFooter = columns.some((c) => c.footer);
  const showFooter = hasFooter && !loading && !error && total > 0;

  // 열 폭(설계 122): 번호 열은 척도 고정, 나머지는 컬럼 정의를 따른다.
  // undefined = 가변 텍스트 열(기준폭 160). 남는 폭은 colStyles 가 전 열에 똑같이 나눈다.
  const colWidths: (number | undefined)[] = [
    ...(numbered ? [HH_COL.num] : []),
    ...columns.map((c) => c.width),
  ];
  const tableMinPx = minWidth ?? tableMinWidth(colWidths);

  // 그룹 구분줄: 현재 페이지 행을 연속 키로 묶는다. render에는 키의 전체 행(일 합계용)을 넘긴다.
  // ★2단이면 좌·우 표가 각자 구분줄을 가져야 하므로, 행 묶음을 받아 만드는 함수로 뽑았다.
  type Segment = { key: string; allRows: T[]; rows: { row: T; rowNumber: number }[] };
  const allByKey = useMemo(() => {
    if (!groupBy) return null;
    const m = new Map<string, T[]>();
    for (const r of sorted) {
      const k = groupBy.key(r);
      const arr = m.get(k);
      if (arr) arr.push(r);
      else m.set(k, [r]);
    }
    return m;
  }, [groupBy, sorted]);
  const buildSegments = useCallback(
    (slice: T[], numberBase: number): Segment[] | null => {
      if (!groupBy || !allByKey) return null;
      const segs: Segment[] = [];
      slice.forEach((row, i) => {
        const k = groupBy.key(row);
        const rowNumber = numberBase + i + 1;
        const last = segs[segs.length - 1];
        if (last && last.key === k) last.rows.push({ row, rowNumber });
        else segs.push({ key: k, allRows: allByKey.get(k) ?? [], rows: [{ row, rowNumber }] });
      });
      return segs;
    },
    [groupBy, allByKey]
  );
  const segments = useMemo(() => buildSegments(pageRows, rowBase), [buildSegments, pageRows, rowBase]);
  const leftSegments = useMemo(() => buildSegments(leftRows, rowBase), [buildSegments, leftRows, rowBase]);
  const rightSegments = useMemo(() => buildSegments(rightRows, rowBase + pageSize), [buildSegments, rightRows, rowBase, pageSize]);

  // 2단이면 [왼쪽(=앞 페이지), 오른쪽(=다음 페이지)], 1단이면 한 벌. 합계줄은 마지막 표에만 둔다.
  const tableParts: { segs: Segment[] | null; slice: T[]; numberBase: number; withFooter: boolean }[] = twoUp
    ? [
        { segs: leftSegments, slice: leftRows, numberBase: rowBase, withFooter: rightRows.length === 0 },
        ...(rightRows.length > 0
          ? [{ segs: rightSegments, slice: rightRows, numberBase: rowBase + pageSize, withFooter: true }]
          : []),
      ]
    : [{ segs: segments, slice: pageRows, numberBase: rowBase, withFooter: true }];

  return (
    <div className="space-y-3">
      {/* 전체 건수 (CRM 스타일 — 조회건수/정렬 드롭다운 제거). 탭 배지로 이미 보이면 숨김. */}
      {showCount ? (
        <div className="text-sm text-muted-foreground">
          전체 <span className="font-semibold text-foreground">{total}</span>건
        </div>
      ) : null}

      {/* 표 (데스크톱 전용). 2단이면 이 블록을 좌·우 두 번 그린다. (설계 145)
          ★2026-08-11: 2단 분기를 md(768) → 2xl(1536) 로 올렸다. md 부터 2단으로 쪼개면 각 단이
            **표보다 좁아져 오른쪽 열이 통째로 잘린다** — 실측 1280px 에서 껍데기 515px vs 표 592px.
            껍데기가 overflow-x:auto 라 가로 스크롤로 '숨겨지는' 탓에 검사 D 가 못 잡았고,
            그래서 팀장이 화면에서 발견할 때까지 계속 잘려 있었다(설계 162 ⑨, 검사 I 신설).
            2단이 성립하려면 콘텐츠 폭 ≥ 표*2 + gap 이라, 페이지 최대폭 1200 기준 2xl 이 하한이다.
          ⚠️**이 가드는 여유가 0 이다**(교차리뷰 M2). 2xl 이상에서 단 폭은 정확히 592px 이라
            592px 표는 딱 맞고 **593px 만 돼도 다시 잘린다**. 이번 사고의 원인이 바로 "592 → 640 으로
            슬금슬금 커진 것"이었으니 같은 방식으로 재발한다 — twoUp 을 쓰려면 표 폭을 실측하고
            `npm run test:table-render` 의 검사 I 를 반드시 돌려라(그건 `npm test` 체인 밖이다).
          ⚠️2xl 미만 폴백은 표 두 벌이 **간격 0px 로 세로로 쌓이고 `<thead>` 가 중복**된다(교차리뷰 M1).
            지금은 twoUp 사용처가 0 개라 드러나지 않지만, 다시 쓸 땐 CSS 가 아니라 렌더 분기에서
            끄는 편이 낫다. */}
      <div
        className={cn(
          "hidden",
          twoUp ? "md:block 2xl:flex 2xl:items-start 2xl:gap-3" : "md:block",
          !twoUp && HH_TABLE.shell
        )}
      >
        {tableParts.map(({ segs, slice, numberBase, withFooter }, ti) => {
        const table = (
        <table key={ti} className={HH_TABLE.table} style={{ width: tableMinPx }}>
          {/* 열 폭은 여기 한 곳에서만 준다 — th/td className 에 폭을 섞으면 출처가 갈라진다. (설계 122) */}
          <colgroup>
            {colStyles(colWidths).map((st, i) => (
              <col key={i} style={st} />
            ))}
          </colgroup>
          <thead>
            <tr className={HH_TABLE.headRow}>
              {/* 번호 열도 패딩은 다른 열과 같아야 한다(px-3 을 섞으면 내용 사이 공간이 어긋난다) */}
              {numbered ? <th className={cn(HH_TABLE.th, "text-center")}>번호</th> : null}
              {columns.map((c) => {
                const s = sortOf(c.key);
                const active = s != null && sortKey === c.key;
                return (
                  <th key={c.key} className={cn(HH_TABLE.th, alignClass[c.align ?? "left"], c.className)}>
                    {s ? (
                      // ★버튼을 헤더 폭에 맞춰 늘린다(w-full) — 안 그러면 클릭 영역이 글자만큼이라 잘 안 눌린다.
                      //   정렬 화살표는 **활성 열에만** 보인다: 모든 열에 늘 띄우면 헤더가 그만큼 넓어져
                      //   좁은 열('상환일'·'이자율')이 두 줄로 꺾인다(표 검사 E). 나머지는 hover 로 알린다.
                      <button
                        type="button"
                        onClick={() => toggleSort(c.key)}
                        title={`${s.label}으로 정렬${active ? " (다시 누르면 역순)" : ""}`}
                        className={cn(
                          "group inline-flex w-full items-center gap-1 whitespace-nowrap rounded hover:text-foreground",
                          alignClass[c.align ?? "left"] === "text-right" ? "justify-end" : "justify-start",
                          active ? "font-semibold text-foreground" : "text-inherit"
                        )}
                      >
                        <span>{c.header}</span>
                        <span aria-hidden className={cn("text-[10px] leading-none", active ? "opacity-100" : "opacity-0 group-hover:opacity-50")}>
                          {active && reversed ? "▲" : "▼"}
                        </span>
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={colCount} className="px-4 py-10"><LoadingState label="불러오는 중..." /></td></tr>
            ) : error ? (
              <tr><td colSpan={colCount} className="px-4 py-10"><ErrorState onRetry={onRetry} /></td></tr>
            ) : slice.length === 0 ? (
              <tr><td colSpan={colCount} className="px-4 py-16 text-center text-sm text-muted-foreground">
                <p>{emptyText}</p>
                {emptyAction ? <div className="mt-4 flex justify-center">{emptyAction}</div> : null}
              </td></tr>
            ) : segs ? (
              segs.map((seg) => (
                <Fragment key={`g-${seg.key}-${seg.rows[0].rowNumber}`}>
                  <tr className="border-b border-border/40 bg-muted/40">
                    <td colSpan={colCount} className="px-4 py-1.5 text-xs font-semibold text-muted-foreground">
                      {groupBy!.render(seg.key, seg.allRows)}
                    </td>
                  </tr>
                  {seg.rows.map(({ row, rowNumber }) => (
                    <tr
                      key={rowKey(row)}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                      className={cn(HH_TABLE.row, onRowClick && "cursor-pointer hover:bg-muted/40")}
                    >
                      {numbered ? <td className={cn(HH_TABLE.td, "text-center text-muted-foreground")}>{rowNumber}</td> : null}
                      {columns.map((c) => (
                        <td key={c.key} className={cn(HH_TABLE.td, alignClass[c.align ?? "left"], c.className)}>
                          {c.cell(row, rowNumber)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))
            ) : (
              slice.map((row, i) => {
                const rowNumber = numberBase + i + 1;
                return (
                  <tr
                    key={rowKey(row)}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={cn(HH_TABLE.row, onRowClick && "cursor-pointer hover:bg-muted/40")}
                  >
                    {numbered ? <td className={cn(HH_TABLE.td, "text-center text-muted-foreground")}>{rowNumber}</td> : null}
                    {columns.map((c) => (
                      <td key={c.key} className={cn(HH_TABLE.td, alignClass[c.align ?? "left"], c.className)}>
                        {c.cell(row, rowNumber)}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
          {showFooter && withFooter ? (
            <tfoot>
              <tr className={HH_TABLE.footRow}>
                {numbered ? <td className={HH_TABLE.footTd} /> : null}
                {columns.map((c) => (
                  <td key={c.key} className={cn(HH_TABLE.footTd, alignClass[c.align ?? "left"], c.className)}>
                    {c.footer ? c.footer(sorted) : null}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
        );
        // 2단일 때만 표마다 껍데기를 씌운다(1단은 바깥 div 가 이미 껍데기다).
        return twoUp ? <div key={ti} className={HH_TABLE.shell}>{table}</div> : table;
        })}
      </div>

      {/* 카드 목록 (모바일 전용) — 테이블 컬럼을 라벨·값 쌍으로 펼쳐 금액까지 항상 보이게 */}
      <div className="space-y-2 md:hidden">
        {loading ? (
          <div className="rounded-2xl border border-border/70 bg-card/85 px-4 py-10 shadow-sm"><LoadingState label="불러오는 중..." /></div>
        ) : error ? (
          <div className="rounded-2xl border border-border/70 bg-card/85 px-4 py-10 shadow-sm"><ErrorState onRetry={onRetry} /></div>
        ) : pageRows.length === 0 ? (
          <div className="rounded-2xl border border-border/70 bg-card/85 px-4 py-16 text-center text-sm text-muted-foreground shadow-sm">
            <p>{emptyText}</p>
            {emptyAction ? <div className="mt-4 flex justify-center">{emptyAction}</div> : null}
          </div>
        ) : (
          (segments ?? [{ key: "", allRows: [] as T[], rows: pageRows.map((row, i) => ({ row, rowNumber: safePage * pageSize + i + 1 })) }]).map((seg, si) => (
            <Fragment key={segments ? `g-${seg.key}-${seg.rows[0].rowNumber}` : `p-${si}`}>
              {segments ? (
                <div className="px-1 pt-2 text-xs font-semibold text-muted-foreground first:pt-0">
                  {groupBy!.render(seg.key, seg.allRows)}
                </div>
              ) : null}
              {seg.rows.map(({ row, rowNumber }) => (
                <div
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    "rounded-2xl border border-border/70 bg-card/85 p-4 shadow-sm transition-colors",
                    onRowClick && "cursor-pointer active:bg-muted/40"
                  )}
                >
                  {columns.some((c) => c.mobile) ? (
                    // 압축 카드(설계 99 E): 1행 = title↔amount 굵게, 2행 = meta 나열. 힌트 없는 컬럼은 meta 취급.
                    <div className="space-y-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 truncate text-sm font-semibold">
                          {columns.filter((c) => c.mobile === "title").map((c) => <Fragment key={c.key}>{c.cell(row, rowNumber)}</Fragment>)}
                        </span>
                        <span className="shrink-0 text-right text-sm font-semibold tabular-nums">
                          {columns.filter((c) => c.mobile === "amount").map((c) => <Fragment key={c.key}>{c.cell(row, rowNumber)}</Fragment>)}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        {columns
                          .filter((c) => !c.mobile || c.mobile === "meta")
                          .map((c, i) => (
                            <Fragment key={c.key}>
                              {i > 0 ? <span aria-hidden>·</span> : null}
                              <span className="min-w-0">{c.cell(row, rowNumber)}</span>
                            </Fragment>
                          ))}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {columns.map((c) => (
                        <div key={c.key} className="flex items-baseline justify-between gap-3">
                          <span className="shrink-0 text-xs text-muted-foreground">{c.header}</span>
                          <span className="min-w-0 text-right text-sm">{c.cell(row, rowNumber)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </Fragment>
          ))
        )}
        {/* 합계 카드 — 어느 컬럼이든 footer 를 정의하면 표시(현재 필터/정렬 전체 기준) */}
        {showFooter ? (
          <div className="rounded-2xl border-2 border-border bg-muted/40 p-4 shadow-sm">
            <div className="space-y-1.5">
              {columns.filter((c) => c.footer).map((c) => (
                <div key={c.key} className="flex items-baseline justify-between gap-3">
                  <span className="shrink-0 text-xs font-semibold text-muted-foreground">{c.header}</span>
                  <span className="min-w-0 text-right text-sm font-semibold">{c.footer!(sorted)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {/* 페이지네이션 */}
      {!loading && !error && totalPages > 1 ? (
        <div className="flex items-center justify-center gap-3 text-sm">
          <button
            type="button"
            disabled={safePage === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="inline-flex h-9 items-center gap-1 rounded-lg border border-border/70 px-3 text-muted-foreground hover:bg-muted/50 disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" /> 이전
          </button>
          <span className="text-muted-foreground">{safePage + 1} / {totalPages}</span>
          <button
            type="button"
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            className="inline-flex h-9 items-center gap-1 rounded-lg border border-border/70 px-3 text-muted-foreground hover:bg-muted/50 disabled:opacity-40"
          >
            다음 <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
