"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";

import { AmountInput } from "@/components/household/amount-input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { planQuickInterestBatch, QUICK_INTEREST } from "@/lib/household/quick-interest";

// 수집함 수동 추가 팝업(inbox-dialog)과 같은 모양을 쓴다.
const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base md:text-sm shadow-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

/**
 * 토스 이자 빠른 입력 팝업. (설계 docs/household/172 · 여러 건은 184)
 *
 * 평소 손대는 것은 **금액**이다. 상대처·카테고리는 고정값이라 묻지 않고 아래에 적어만 둔다.
 * 날짜는 오늘이 기본이고, 어제 것을 몰아 넣을 때만 바꾼다.
 *
 * ★설계 184: 토스뱅크는 상품(통장·모으기 등)마다 이자가 **따로** 들어와 하루에 소액이 여러 건이다.
 *   팝업을 건마다 다시 여는 대신 **금액 줄을 늘려** 한 번에 넣는다 — 날짜·계좌는 공통, 줄마다 한 건.
 *   1건만 넣는 흐름(금액 하나 → 엔터)은 그대로다. 빈 줄은 저장 때 무시된다.
 *
 * ★입금계좌만은 **화면에 드러내고 사람이 고른다.** 같은 은행 계좌가 명의별로 둘이라
 *   자동 추론(이자가 들어오던 계좌)만 믿으면 ⓐ그 계좌가 비활성화됐을 때 남은 다른 명의 계좌를
 *   조용히 집거나 ⓑ과거 오귀속을 그대로 물려받는다(교차리뷰 2026-08-14, Codex 2차).
 *   기본값이 채워져 있으면 그대로 엔터라 손은 여전히 한 번이다.
 */
export function QuickInterestDialog({
  open,
  onOpenChange,
  today,
  accounts,
  defaultAccountId,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 오늘 날짜(YYYY-MM-DD). 서울 기준 값을 호출부가 준다. */
  today: string;
  /** 고를 수 있는 입금계좌 후보(활성 + 해당 은행). 비어 있으면 저장할 수 없다. */
  accounts: { id: string; name: string }[];
  /** 기본으로 골라 둘 계좌. 근거가 어긋나면 null 로 와서 **사람이 직접 고르게** 된다. */
  defaultAccountId: string | null;
  /** 금액은 **입력한 순서 그대로, 빈 줄(0)은 뺀** 목록으로 넘어간다. 한 줄 = 수집함 한 행. */
  onSave: (input: { amounts: number[]; date: string; accountId: string }) => Promise<unknown>;
}) {
  // 줄마다 고정 key 를 붙인다 — 인덱스 key 면 가운데 줄을 지울 때 AmountInput 인스턴스(수식 원문 draft)가
  // 아랫줄 값과 어긋날 수 있다(리뷰 2026-08-19). key 는 늘어나기만 하는 일련번호.
  const nextKey = useRef(1);
  const [rows, setRows] = useState<{ k: number; amount: number }[]>([{ k: 0, amount: 0 }]);
  const amounts = rows.map((r) => r.amount);
  const [date, setDate] = useState(today);
  const [accountId, setAccountId] = useState<string>(defaultAccountId ?? "");
  const [saving, setSaving] = useState(false);
  // 「+ 한 건 더」로 줄을 늘리면 새 줄에 바로 커서를 둔다 — 마우스로 옮기는 손을 줄인다.
  // ★인덱스가 아니라 **플래그**로 둔다 — 인덱스를 렌더 시점 `rows.length` 로 잡으면 리렌더 전에
  //   두 번 누를 때 둘 다 같은 값이라 커서가 새 줄이 아닌 곳에 간다(리뷰 2026-08-19).
  //   새 줄은 언제나 맨 끝이므로 "마지막 줄"이면 충분하고, setRows 업데이터에 부작용을 넣지 않아도 된다.
  const [focusLast, setFocusLast] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // ★열 때 **한 번만** 초기화한다. deps 에 defaultAccountId·today 를 그대로 두면
  //   팝업이 열려 있는 동안 뒤에서 목록이 갱신될 때 **입력하던 금액까지 지워진다**
  //   (교차리뷰 2026-08-14 2차, Codex). 그래서 최신 값은 ref 로 읽고 effect 는 open 에만 건다.
  const latest = useRef({ today, defaultAccountId });
  latest.current = { today, defaultAccountId };
  useEffect(() => {
    if (!open) return;
    setRows([{ k: nextKey.current++, amount: 0 }]);
    setDate(latest.current.today);
    setAccountId(latest.current.defaultAccountId ?? "");
    setFocusLast(false);
  }, [open]);

  useEffect(() => {
    if (!focusLast) return;
    inputRefs.current[rows.length - 1]?.focus();
    setFocusLast(false);
  }, [focusLast, rows.length]);

  const plan = planQuickInterestBatch(amounts);
  const count = plan.rows.length;

  const setAmountAt = (i: number, n: number) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, amount: n } : r)));
  const addRow = () => {
    setRows((prev) => [...prev, { k: nextKey.current++, amount: 0 }]);
    setFocusLast(true);
  };
  const removeRow = (i: number) => {
    // 마지막 한 줄은 지우지 않고 비운다 — 줄이 0개가 되면 넣을 데가 없다.
    setRows((prev) => (prev.length <= 1 ? [{ k: nextKey.current++, amount: 0 }] : prev.filter((_, idx) => idx !== i)));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (plan.error) return toast.error(plan.error);
    // ★계좌는 사람이 고른 값만 쓴다 — 자동 추론만으로는 같은 은행의 다른 명의 계좌를
    //   조용히 고를 수 있다(교차리뷰 2026-08-14).
    if (!accountId) return toast.error("입금계좌를 선택해주세요.");
    setSaving(true);
    try {
      await onSave({ amounts: plan.rows.map((r) => r.amount), date, accountId });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>토스 이자 넣기</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="qi-amount-0">금액 (원) *</Label>
            {/* 줄마다 한 건. 첫 줄만 라벨·자동초점, 나머지는 「+ 한 건 더」로 늘어난다(설계 184). */}
            <div className="space-y-2">
              {rows.map((row, i) => (
                <div key={row.k} className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <AmountInput
                      id={`qi-amount-${i}`}
                      ref={(el) => {
                        inputRefs.current[i] = el;
                      }}
                      value={row.amount}
                      onValueChange={(n) => setAmountAt(i, n)}
                      allowFormula
                      placeholder={i === 0 ? "예: 128" : "예: 3"}
                      autoFocus={i === 0}
                      // 첫 줄은 <Label htmlFor> 가 읽어 준다 — aria-label 을 같이 주면 라벨을 덮는다.
                      aria-label={i === 0 ? undefined : `금액 ${i + 1}`}
                    />
                  </div>
                  {rows.length > 1 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0 text-muted-foreground"
                      onClick={() => removeRow(i)}
                      aria-label={`${i + 1}번째 줄 지우기`}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between gap-2">
              <Button type="button" variant="outline" size="sm" onClick={addRow}>
                <Plus className="mr-1 h-4 w-4" />
                한 건 더
              </Button>
              {count >= 2 ? (
                <span className="text-xs text-muted-foreground">
                  {count}건 · 합계 {plan.total.toLocaleString()}원
                </span>
              ) : null}
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="qi-date">날짜</Label>
            {/* ★max=오늘 — 미래 날짜를 넣으면 '마지막 이자 기록'이 미래가 되어 그날까지
                미입력 경고가 잠긴다(교차리뷰 2026-08-14). 핸들러에서도 한 번 더 막는다. */}
            <Input
              id="qi-date"
              type="date"
              value={date}
              max={today}
              required
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="qi-account">입금계좌 *</Label>
            <select
              id="qi-account"
              className={selectClass}
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              required
            >
              <option value="">선택</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            {accounts.length === 0 ? (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {QUICK_INTEREST.accountBank} 계좌를 찾지 못했습니다 — 계좌를 먼저 등록하거나
                활성 상태인지 확인해 주세요.
              </p>
            ) : !defaultAccountId ? (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                이자가 들어오던 계좌를 확정할 수 없어 비워 뒀습니다 — 한 번만 직접 골라 주세요.
              </p>
            ) : null}
          </div>
          <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            <strong className="text-foreground">{QUICK_INTEREST.merchant}</strong> · 수입 ·{" "}
            {QUICK_INTEREST.categoryName} 로 <strong className="text-foreground">줄마다 한 건씩</strong> 저장하고{" "}
            <strong className="text-foreground">바로 확정</strong>합니다. 한 건으로 합치려면 <code>128+15</code> 처럼 적으세요.
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              취소
            </Button>
            <Button type="submit" disabled={saving || accounts.length === 0}>
              {saving ? "저장 중..." : count >= 2 ? `${count}건 넣고 확정` : "넣고 확정"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
