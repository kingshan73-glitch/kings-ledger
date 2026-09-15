// 설계 202 — 크로스소스 dedup(설계 63) 오탐을 **잔액 사슬의 안정 상태 복귀 여부**로 사후 탐지한다.
//
// 같은 가게에서 같은 금액을 초 단위로 두 번 결제하면 중복과 사전에 구별할 방법이 없다.
// 그런데 내려간 쪽(패자)은 거의 항상 은행 SMS 이고, 은행 SMS 가 찍은 잔액은 **우리 판정과
// 무관한 외부 증거**다 — 은행은 실제로 나간 것만 잔액에 반영한다.
//
//   진짜 중복 → 한 번만 나갔고 장부도 한 건이다 → 사슬이 안정 상태로 **되돌아온다**
//   오탐     → 두 번 나갔는데 장부엔 한 건뿐이다 → 안정 상태 위 **금액만큼**에 눌러앉는다
//
// 이 파일은 DB 를 모른다. 재료(장부·미확정 pending·문자잔액 관측)를 받아 판정만 한다.
// 판정 규칙과 한계는 docs/household/202_dedup-falsepos-balance-audit.md 참조.

/** 문자잔액 관측 하나. 같은 날 여러 건이면 **순서키로** 마지막을 고른다(아래 sortChain 참조). */
export type ChainObservation = {
  date: string | null;
  balance: number;
  /** 본문 시각(HH:MM). 없을 수 있다. */
  time?: string | null;
  /** 시각까지 같을 때 쓰는 도착 순서(created_at 등). */
  seq?: string | null;
  /** 마지막 안정 tiebreak. uuid 라도 결과가 실행마다 흔들리지 않게만 한다. */
  id?: string | null;
  kind?: string | null;
};
/** 그날 마지막 문자잔액(정렬·집계가 끝난 값). */
export type ChainPoint = { date: string; balance: number };
/** 장부의 일자별 순증감 — 계좌 기준으로 부호를 적용한 값(출금이면 음수). */
export type DayDelta = { date: string; delta: number };
/**
 * 아직 확정하지 않은 수집행의 예상 반영(출금이면 음수).
 * ★이걸 빼지 않으면 미확정 pending 이 잔차를 +금액 만들어 **오탐과 똑같은 모양**이 된다.
 */
export type PendingDelta = { date: string; delta: number };

/** 장부 거래와 미확정 수집행에 **똑같이** 쓰는, 계좌 기준 증감 규칙. */
export type MoneyRow = {
  type: string | null;
  amount: number | null;
  account_id: string | null;
  from_account_id: string | null;
  to_account_id: string | null;
};

/**
 * 이 거래(또는 미확정 수집행)가 그 계좌의 잔액을 얼마나 움직이는가.
 *
 * ★신용카드 할부(`installment`)는 카드에 쌓일 뿐 은행 계좌 잔액을 건드리지 않는다 — 0 이 맞다.
 *   `KNOWN_TYPES` 에 넣어 두는 이유는 "모르는 유형"과 구별하기 위해서다(모르는 유형은 알려야 한다).
 *   ★`hh_transaction.type` 은 DB CHECK 로 이 다섯 개에 묶여 있다. 제약이 **없는** 쪽은
 *   `hh_transaction_inbox.guessed_type` 이므로, 미지 유형 경고는 그쪽에 걸어야 뜻이 있다.
 */
export const KNOWN_TYPES = ["income", "expense", "payment", "transfer", "installment"] as const;

export function ledgerDelta(r: MoneyRow, accountId: string): number {
  const a = Number(r.amount ?? 0);
  if (!a) return 0;
  if (r.type === "income" && r.account_id === accountId) return a;
  if (r.type === "expense" && r.account_id === accountId) return -a;
  if (r.type === "payment" && r.from_account_id === accountId) return -a;
  if (r.type === "transfer") return (r.to_account_id === accountId ? a : 0) + (r.from_account_id === accountId ? -a : 0);
  return 0;
}

export type ResidualPoint = { date: string; residual: number };

/** 재료에서 **조용히 빠진** 미확정 pending — 빠진 출금 하나가 잔차를 통째로 밀어 올린다. */
export type DroppedPending = { date: string; amount: number | null; why: "계좌미상" | "유형미상" | "취소" };

export type Verdict = "true-duplicate" | "false-positive-suspect" | "undecidable";

export type Judgement = {
  verdict: Verdict;
  /** 사슬의 안정 상태 — 후보 이전 잔차가 가장 자주 되돌아가는 값. 못 정했으면 null. */
  baseline: number | null;
  /** 그 안정 상태가 후보 이전에 몇 번 나왔나(근거의 두께). */
  baselineCount: number;
  /** 후보 이후 잔차가 가장 자주 머무는 값 − 안정 상태. 판정 불가여도 근거로 남긴다. */
  shift: number | null;
  /** 후보 이후에 안정 상태로 되돌아온 적이 있나 — 있으면 그 돈은 한 번만 나갔다. */
  returnsToBaseline: boolean;
  /** 후보 이후 관측 중 안정 상태에 닿은 수 / `안정상태+금액` 에 앉은 수. 둘 다 0 이 아니면 사슬이 흔들린 것이다. */
  afterAtBaseline: number;
  afterAtShifted: number;
  beforeN: number;
  afterN: number;
  reason: string;
};

/**
 * ★같은 날 문자가 여러 건일 때 **무엇이 '그날 마지막'인가**를 정한다.
 *
 * 이게 이 파일에서 가장 위험한 함수다. 후보 당일의 관측은 판정에서 가장 무거운 한 점인데,
 * 순서를 `id`(무작위 uuid)로 가르면 **동전 던지기**가 된다 — 그리고 하필 이 설계가 존재하는 이유인
 * "같은 가게·같은 금액을 초 단위로 두 번" 은 **본문 시각이 분 단위라 같은 값**이라, 정확히 그 상황에서
 * 동전이 던져진다(2026-09-04 배포 전 리뷰 Critical).
 *
 * 그래서 `time`(본문 시각) → `seq`(도착 순서, created_at) → `id` 순으로 가른다.
 * - 시각이 없는 행은 **먼저**로 본다 — 모르는 행이 아는 행을 제치고 '마지막'을 차지하면 안 된다.
 * - `seq` 는 도착 순서라 거래 순서와 다를 수 있다(설계 200 의 63ms 경쟁). 다만 **같은 폰이 순서대로
 *   보내는 같은 소스의 문자**에는 맞고, 무작위 uuid 보다는 언제나 낫다.
 */
export function sortChain(rows: readonly ChainObservation[]): ChainObservation[] {
  const key = (r: ChainObservation) => [r.date ?? "", r.time ?? "", r.seq ?? "", r.id ?? ""];
  return [...rows].sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  });
}

/**
 * 계좌 하나의 재료를 만든다 — 조회 결과를 잔차 계산에 넣을 모양으로 접는다.
 *
 * ★`from` 이전은 **장부든 미확정 pending 이든 똑같이 기초잔액으로 접어 넣는다.**
 *   장부만 접고 pending 을 버리면, 아직 확정 안 된 과거 출금이 `from` 이후 문자잔액에는 이미
 *   반영돼 있어 **영구 잔차**를 만든다(2026-09-04 교차검토 High).
 * ★점수를 매길 수 없어 **빠진 pending 은 세어서 돌려준다** — 빠진 출금 하나가 잔차를 정확히
 *   그 금액만큼 밀어 올려 **오탐과 똑같은 모양**을 만들기 때문이다. 조용히 버리면 안 된다.
 */
export function buildAccountMaterials(input: {
  accountId: string;
  openingBalance: number;
  /** 이 날짜부터 관측한다. 그 이전은 전부 기초잔액으로 접는다. */
  from: string;
  ledgerRows: readonly (MoneyRow & { date: string })[];
  pendingRows: readonly (MoneyRow & { date: string | null; kind?: string | null })[];
  chainRows: readonly ChainObservation[];
}): { opening: number; ledger: DayDelta[]; pending: PendingDelta[]; chain: ChainPoint[]; dropped: DroppedPending[] } {
  let opening = input.openingBalance;
  const ledger: DayDelta[] = [];
  for (const r of input.ledgerRows) {
    const d = ledgerDelta(r, input.accountId);
    if (!d) continue;
    if (r.date < input.from) opening += d;
    else ledger.push({ date: r.date, delta: d });
  }

  const known = new Set<string>(KNOWN_TYPES);
  const pending: PendingDelta[] = [];
  const dropped: DroppedPending[] = [];
  for (const r of input.pendingRows) {
    if (!r.date) continue;
    if (r.kind === "cancel") { dropped.push({ date: r.date, amount: r.amount, why: "취소" }); continue; }
    const d = ledgerDelta(r, input.accountId);
    if (d) {
      if (r.date < input.from) opening += d; // ★장부와 같은 자로 접는다
      else pending.push({ date: r.date, delta: d });
      continue;
    }
    // 0 이 나온 이유가 '남의 계좌'면 정상이고, '계좌를 모른다'면 우리 사슬이 그만큼 틀어질 수 있다.
    if (!r.type || !known.has(r.type)) dropped.push({ date: r.date, amount: r.amount, why: "유형미상" });
    else if (r.account_id == null && r.from_account_id == null && r.to_account_id == null)
      dropped.push({ date: r.date, amount: r.amount, why: "계좌미상" });
  }

  const chain: ChainPoint[] = [];
  for (const c of sortChain(input.chainRows)) {
    if (!c.date || c.kind === "cancel" || c.date < input.from) continue;
    chain.push({ date: c.date, balance: Number(c.balance) });
  }
  return { opening, ledger, pending, chain, dropped };
}

/**
 * 관측일마다 `장부EOD + 미확정pending − 그날 마지막 문자잔액` 을 낸다.
 * 문자잔액이 찍힌 날에만 값이 생긴다(그 밖의 날은 대조할 외부 증거가 없다).
 *
 * `chain` 은 **이미 정렬된 것**으로 본다(buildAccountMaterials 가 sortChain 으로 정렬한다) —
 * 같은 날 여러 건이면 뒤에 온 것이 그날 마지막이다.
 */
export function buildResiduals(input: {
  opening: number;
  ledger: DayDelta[];
  pending: PendingDelta[];
  chain: ChainPoint[];
}): ResidualPoint[] {
  const byDay = new Map<string, number>();
  for (const { date, delta } of [...input.ledger, ...input.pending])
    byDay.set(date, (byDay.get(date) ?? 0) + delta);

  const lastOfDay = new Map<string, number>();
  for (const c of input.chain) lastOfDay.set(c.date, c.balance);

  const out: ResidualPoint[] = [];
  let book = input.opening;
  for (const date of [...new Set([...byDay.keys(), ...lastOfDay.keys()])].sort()) {
    book += byDay.get(date) ?? 0;
    const rep = lastOfDay.get(date);
    if (rep == null) continue;
    out.push({ date, residual: book - rep });
  }
  return out;
}

/**
 * 사슬의 **안정 상태** — 가장 자주 되풀이되는 잔차 값.
 *
 * ★중앙값도 평균도 아니다. 실측(2026-09-04)에서 잔차는 '그날 마지막 문자 이후의 지출' 때문에
 *   날마다 제각각으로 튀고, 사슬이 따라잡은 날에만 같은 값으로 **되돌아온다**:
 *   우리은행 0×12/32일 · 국민(이바다) 0×24/33일 · 부천페이(이바다) 0×10/15일.
 *   그래서 되돌아오는 그 값이 기준이고, 나머지는 잡음이다.
 *
 * 동률이면 ⓐ0 에 가까운 쪽 ⓑ그래도 같으면 **작은 값**을 고른다 — 입력 순서에 따라 결과가
 * 흔들리면 안 된다(2026-09-04 배포 전 리뷰 M4).
 */
export function findBaseline(xs: readonly number[], minCount: number): { value: number; count: number } | null {
  const hist = new Map<number, number>();
  for (const x of xs) hist.set(x, (hist.get(x) ?? 0) + 1);
  let best: { value: number; count: number } | null = null;
  for (const [value, count] of hist) {
    if (!best) { best = { value, count }; continue; }
    if (count !== best.count) { if (count > best.count) best = { value, count }; continue; }
    const da = Math.abs(value), db = Math.abs(best.value);
    if (da < db || (da === db && value < best.value)) best = { value, count };
  }
  return best && best.count >= minCount ? best : null;
}

/**
 * `status='duplicate'` 로 내려간 행 하나를 판정한다.
 *
 * ★후보 **당일**의 문자잔액은 '이후' 쪽으로 센다 — 그 문자 자체가 두 번째 출금의 증거이기 때문이다.
 *   (그 '당일 마지막'을 무엇으로 정하는지가 `sortChain` 이다. 거기가 이 판정의 급소다.)
 * ★절대값이 아니라 **안정 상태로 되돌아오는가**를 본다 — 계좌에 만성 오차가 있어도 상관없다.
 *   진짜 중복이면 사슬이 언젠가 안정 상태로 복귀하고, 오탐이면 **다른 장부 오차가 겹치지 않는 한**
 *   복귀하지 못한다(장부에서 빠진 그 금액은 저절로 메워지지 않는다).
 *
 * ★두 방향의 한계를 알고 쓴다(2026-09-04 교차검토 High 둘 다 타당했다):
 *   ⓐ 오탐 뒤에 **정반대 부호의 다른 오차**가 우연히 겹친 날이 하루 있으면 복귀로 읽혀 `true-duplicate`
 *      가 된다. 조용한 쪽이라 위험이 작지만 참이 아닐 수 있다 — 그래서 `afterAtShifted` 를 함께 돌려주고,
 *      복귀와 어긋남이 **섞여 있으면 그 사실을 reason 에 적는다.**
 *   ⓑ 반대로 `안정상태+금액` 에 **한 번 닿았다는 이유로** 늑대를 부르지 않는다 — 오탐 판정은
 *      후보 이후 관측이 `minAfterForSuspect` 건 이상이고 **그 값이 최빈값일 때만** 낸다.
 */
export function auditCandidate(input: {
  residuals: readonly ResidualPoint[];
  candidate: { date: string; amount: number | null; balance: number | null; accountId: string | null };
  /** 안정 상태로 인정하려면 후보 이전에 최소 몇 번 나와야 하는가. 기본 3. */
  minBaselineCount?: number;
  /** 오탐이라고 말하려면 후보 이후 관측이 최소 몇 건이어야 하는가. 기본 2(늑대는 근거를 더 요구한다). */
  minAfterForSuspect?: number;
}): Judgement {
  const { residuals, candidate } = input;
  const minBaselineCount = input.minBaselineCount ?? 3;
  const minAfterForSuspect = input.minAfterForSuspect ?? 2;
  const blank = {
    baseline: null, baselineCount: 0, shift: null, returnsToBaseline: false,
    afterAtBaseline: 0, afterAtShifted: 0, beforeN: 0, afterN: 0,
  };
  const none = (reason: string): Judgement => ({ verdict: "undecidable", ...blank, reason });

  // ★금액은 0 도 막는다 — inbox 의 guessed_amount 엔 `>= 0` CHECK 조차 없다. 0 이면 '안정상태+금액'이
  //   안정 상태 자신과 같아져 판정이 뜻을 잃는다(배포 전 리뷰 L5).
  if (candidate.amount == null || Math.abs(candidate.amount) === 0)
    return none("금액이 없다(또는 0) — 설계 63 은 금액 없는 행을 판정하지 않는다");
  if (candidate.balance == null) return none("문자잔액이 없다 — 대조할 외부 증거가 없다");
  if (candidate.accountId == null) return none("잔액이 어느 계좌인지 모른다(설계 129)");

  const beforeXs = residuals.filter((r) => r.date < candidate.date).map((r) => r.residual);
  const afterXs = residuals.filter((r) => r.date >= candidate.date).map((r) => r.residual);
  const counts = { beforeN: beforeXs.length, afterN: afterXs.length };

  const base = findBaseline(beforeXs, minBaselineCount);
  if (!base)
    return {
      verdict: "undecidable", ...blank, ...counts,
      reason: `후보 이전 관측 ${beforeXs.length}건으로는 사슬의 안정 상태를 정할 수 없다(같은 값이 ${minBaselineCount}번은 나와야 한다)`,
    };
  if (afterXs.length === 0)
    return {
      verdict: "undecidable", ...blank, ...counts, baseline: base.value, baselineCount: base.count,
      reason: "후보 이후 관측이 없다 — 되돌아왔는지 볼 수 없다",
    };

  const amount = Math.abs(candidate.amount);
  const shifted = base.value + amount;
  const afterAtBaseline = afterXs.filter((x) => x === base.value).length;
  const afterAtShifted = afterXs.filter((x) => x === shifted).length;
  const returnsToBaseline = afterAtBaseline > 0;
  // ★후보 이후의 최빈값 — '한 번 닿았다'와 '거기 머문다'를 가르는 자다(교차검토 High ⓑ).
  const afterMode = findBaseline(afterXs, 1);
  const shift = afterMode ? afterMode.value - base.value : null;
  const head = { baseline: base.value, baselineCount: base.count, shift, returnsToBaseline, afterAtBaseline, afterAtShifted, ...counts };

  if (returnsToBaseline) {
    const mixed = afterAtShifted > 0
      ? ` ※다만 ${afterAtShifted}건은 ${amount.toLocaleString()}원 위에 앉아 있다 — 사슬에 다른 오차가 겹쳤을 수 있으니 근거로 삼을 땐 눈으로 확인하라.`
      : "";
    return {
      verdict: "true-duplicate", ...head,
      reason: `후보 이후에도 잔차가 안정 상태(${base.value.toLocaleString()})로 되돌아온다(${afterAtBaseline}/${afterXs.length}건) — 그 돈은 한 번만 나갔다.${mixed}`,
    };
  }
  if (afterXs.length < minAfterForSuspect)
    return {
      verdict: "undecidable", ...head,
      reason: `후보 이후 관측이 ${afterXs.length}건뿐이라 오탐이라고 말하지 않는다(최소 ${minAfterForSuspect}건). 안정 상태 복귀도 아직 없다 — 사슬이 쌓이면 다시 보라`,
    };
  if (afterMode && afterMode.value === shifted)
    return {
      verdict: "false-positive-suspect", ...head,
      reason: `후보 이후 ${afterXs.length}건이 안정 상태로 한 번도 못 돌아오고 ${amount.toLocaleString()}원 위에 머문다(${afterAtShifted}건, 최빈값) — 그 돈은 두 번 나갔다`,
    };
  return { verdict: "undecidable", ...head, reason: `후보 이후 ${afterXs.length}건이 안정 상태로도, ${amount.toLocaleString()}원 위로도 자리 잡지 않는다 — 사슬이 흔들려 판정하지 않는다` };
}
