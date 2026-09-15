"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cardGroupOf } from "@/lib/household/card-group";
import type { HhPaymentMethod } from "@/lib/household/types";

/**
 * '이 달의 결제수단' 팝업. (설계 203)
 *
 * 학원비처럼 **달마다 카드↔지갑이 바뀌는** 항목 때문에 생겼다. 항목에 한 값으로 고정하면
 * 지갑으로 낸 달은 현금 유출이 합계에서 통째로 빠지고(2026-07~09 실측 1,020,000원),
 * 지갑으로 고정하면 카드로 낸 달이 카드대금과 이중계상된다.
 *
 * ★열 폭이 아니라 팝업인 이유: 현금흐름 표는 열 폭 합계가 1184px 로 페이지 상한 1200px 에
 *   16px 밖에 안 남아, '결제방식' 열(88px)을 select 로 바꾸면 상한을 넘겨 모든 화면에
 *   가로 스크롤이 생긴다(CLAUDE.md 표 폭 규칙). 팝업은 저장소 기본 관례이기도 하다(설계 82).
 */
export function MonthMethodDialog({
  open,
  onOpenChange,
  yearMonth,
  itemLabel,
  /** 지금 저장돼 있는 그 달 오버라이드. null 이면 '자동'. */
  value,
  /** 항목 자체에 등록된 결제수단(= '자동'일 때 쓰이는 값). */
  baseMethodId,
  methods,
  /** 화면 마스킹 규칙(설계 39)을 그대로 쓴다 — 이 화면은 계좌·카드명을 가린다. 안 주면 원문. */
  maskName = (v: string) => v,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  yearMonth: string;
  itemLabel: string;
  value: string | null;
  baseMethodId: string | null;
  methods: Pick<HhPaymentMethod, "id" | "name" | "kind" | "is_active">[];
  maskName?: (value: string) => string;
  /** 저장 성공이면 true. false 면 팝업을 열어 둔다(실패한 걸 닫아 버리면 사용자가 모른다). */
  onSave: (methodId: string | null) => Promise<boolean>;
}) {
  const [picked, setPicked] = useState<string | null>(value);
  const [saving, setSaving] = useState(false);
  // 팝업을 다시 열 때 저장된 값에서 시작한다(닫으며 남은 선택이 다음 행으로 새지 않게).
  useEffect(() => {
    if (open) setPicked(value);
  }, [open, value]);

  const byId = new Map(methods.map((m) => [m.id, m]));
  const nameOf = (id: string | null) => (id ? byId.get(id)?.name ?? "(삭제된 수단)" : null);
  const isCard = (id: string | null) => (id ? byId.get(id)?.kind === "credit" : false);
  // 고를 수 있는 것은 활성 수단만. 단 지금 저장된 값이 비활성이면 그것도 보여야 지울 수 있다.
  const selectable = methods.filter((m) => m.is_active || m.id === value);
  const cash = selectable.filter((m) => m.kind === "cash" || m.kind === "check");
  // ★`credit` 만 담는다. 엔진의 카드청구 판정(makeMethodResolver.isCardCharge)은 credit 만 보므로
  //   `installment` 종류를 '카드'라고 안내하면 실제로는 현금 취급이 돼 안내와 동작이 어긋난다
  //   (2026-09-04 교차리뷰 M6). 고르게 하려면 엔진 판정부터 넓혀야 한다.
  const cards = selectable.filter((m) => m.kind === "credit");

  const autoLabel = baseMethodId
    ? `${isCard(baseMethodId) ? "카드" : "현금"} · ${maskName(cardGroupOf(nameOf(baseMethodId) ?? "") ?? nameOf(baseMethodId) ?? "")}`
    : "현금 (등록된 결제수단 없음)";

  const Row = ({ id, label, hint }: { id: string | null; label: string; hint: string }) => (
    <button
      type="button"
      onClick={() => setPicked(id)}
      className={`flex w-full flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors ${
        picked === id ? "border-primary bg-primary/5" : "border-border/60 hover:bg-muted/50"
      }`}
    >
      <span className="text-sm font-medium text-foreground">{label}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>이 달의 결제수단</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{itemLabel}</span> 를 {yearMonth} 에 무엇으로 냈는지 고릅니다.
          <br />
          <span className="text-xs">이 달에만 적용되고, 다음 달은 다시 항목 설정을 따릅니다.</span>
        </p>
        <div className="grid max-h-[50vh] gap-1.5 overflow-y-auto pr-1">
          <Row id={null} label="자동 — 항목 설정을 따름" hint={autoLabel} />
          {cash.length > 0 && (
            <p className="mt-2 px-1 text-xs font-medium text-muted-foreground">현금·지갑 — 그날 통장에서 바로 빠집니다</p>
          )}
          {cash.map((m) => (
            <Row key={m.id} id={m.id} label={maskName(m.name)} hint="현금 결제 — 출금예정 합계·잔액예측에 들어갑니다" />
          ))}
          {cards.length > 0 && (
            <p className="mt-2 px-1 text-xs font-medium text-muted-foreground">카드 — 현금은 카드대금일에 함께 빠집니다</p>
          )}
          {cards.map((m) => (
            <Row
              key={m.id}
              id={m.id}
              label={maskName(m.name)}
              // ★'카드대금으로 넘어간다'는 **그 카드로 결제한 실거래가 있을 때만** 참이다 —
              //   카드대금은 실거래의 결제수단으로만 산출된다(calc.ts creditMethods). 아직 결제 전이거나
              //   실제로 다른 수단으로 냈으면 어느 쪽에도 안 잡힌다(교차리뷰 M7).
              hint="카드 결제 — 합계에서 빠집니다(그 카드 실결제가 있으면 카드대금에 잡힙니다)"
            />
          ))}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            취소
          </Button>
          <Button
            type="button"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try {
                if (await onSave(picked)) onOpenChange(false);
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "저장 중…" : "저장"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
