"use client";

import { Pencil } from "lucide-react";

import { sendLog } from "@/lib/log-client";
import { installmentMonthly } from "@/lib/household/calc";
import { validateInstallmentCounts } from "@/lib/household/installment-validate";
import type { HhCategory, HhPaymentMethod } from "@/lib/household/types";
import { AmountInput } from "@/components/household/amount-input";
import { HH_COL } from "@/components/household/hh-board";
import { BulkEntry, bulkCellInput, bulkSelectClass, todayLocal } from "@/components/household/bulk-entry";
import { findCategoryId, findMethodId, looksLikeHeader, parseAmount, parseDate } from "@/lib/household/paste";

type Row = {
  start_date: string;
  payment_method_id: string;
  category_id: string;
  title: string;
  total_amount: number;
  total_count: number;
  start_installment: number;
};
type Options = { categories: HhCategory[]; methods: HhPaymentMethod[] };

export function InstallmentBulkForm() {
  return (
    <BulkEntry<Row, Options>
      title="할부 등록 (여러 건)"
      breadcrumbs={[{ label: "가계부" }, { label: "지출", href: "/dashboard/household/expenses" }, { label: "할부 등록" }]}
      backHref="/dashboard/household/expenses"
      listHref="/dashboard/household/expenses"
      hint={<><Pencil className="h-3.5 w-3.5" />카드 명세서를 보고 할부 건을 한 줄에 하나씩 입력하세요. 월 금액은 총금액 ÷ 총회차로 자동 계산됩니다.</>}
      addLabel="할부 행 추가"
      // 전 컬럼 균등 분할(7열 = 14.29%) — 설계 120.
      // 부족분은 가장 긴 컬럼(내용)에 준다 — 균등 14.28% 대비 1.6배지만 자유입력 칸이라 허용.
      columns={[
        { label: "시작일", width: HH_COL.standard },
        { label: "사용카드" },
        { label: "카테고리" },
        { label: "내용" },
        { label: "총금액", width: HH_COL.standard, align: "right" },
        { label: "총회차", width: HH_COL.standard, align: "right" },
        { label: "시작회차", width: HH_COL.standard, align: "right" },
      ]}
      loadOptions={async (supabase) => {
        await supabase.auth.getSession();
        const [catRes, mRes] = await Promise.all([
          supabase.from("hh_category").select("*").eq("kind", "expense").eq("is_active", true).order("sort_order").order("name"),
          supabase.from("hh_payment_method").select("*").eq("is_active", true).order("sort_order").order("name"),
        ]);
        const categories = (catRes.data ?? []) as HhCategory[];
        const methods = (mRes.data ?? []) as HhPaymentMethod[];
        if (categories.length === 0 || methods.length === 0) return null;
        return { categories, methods };
      }}
      missingMastersMessage={
        <>할부를 등록하려면 먼저 <b>지출 카테고리</b>와 <b>카드(결제수단)</b>가 필요합니다. 가계부 &gt; 설정에서 만들어 주세요.</>
      }
      emptyRow={(prev) => ({ start_date: prev?.start_date ?? todayLocal(), payment_method_id: prev?.payment_method_id ?? "", category_id: "", title: "", total_amount: 0, total_count: 3, start_installment: 1 })}
      isEmpty={(r) => r.total_amount <= 0 && !r.category_id && !r.title}
      validate={(r) => (!r.category_id ? "카테고리를 선택하세요." : !r.payment_method_id ? "사용카드를 선택하세요." : r.total_amount <= 0 ? "총금액은 1원 이상이어야 합니다." : validateInstallmentCounts(r.total_count, r.start_installment))}
      amountOf={(r) => r.total_amount}
      successMessage={(n) => `할부 ${n}건이 등록되었습니다.`}
      pasteHint={<>컬럼 순서: <b>시작일 · 사용카드명 · 카테고리명 · 내용 · 총금액 · 총회차 · 시작회차</b></>}
      parsePaste={(matrix, options) => {
        const body = matrix.length && looksLikeHeader(matrix[0], 4) ? matrix.slice(1) : matrix;
        let skipped = 0;
        const rows = body
          .map((c) => {
            const total_amount = parseAmount(c[4] ?? "");
            if (total_amount <= 0) { skipped++; return null; }
            const count = parseInt((c[5] ?? "").replace(/[^0-9]/g, ""), 10);
            const start = parseInt((c[6] ?? "").replace(/[^0-9]/g, ""), 10);
            return {
              start_date: parseDate(c[0] ?? "") || todayLocal(),
              payment_method_id: findMethodId(c[1] ?? "", options.methods) ?? "",
              category_id: findCategoryId(c[2] ?? "", options.categories) ?? "",
              title: c[3] ?? "",
              total_amount,
              total_count: Number.isFinite(count) && count >= 1 ? count : 3,
              start_installment: Number.isFinite(start) && start >= 1 ? start : 1,
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);
        return { rows, skipped };
      }}
      onSubmit={async (supabase, rows, owner) => {
        for (const [index, row] of rows.entries()) {
          const err = validateInstallmentCounts(row.total_count, row.start_installment);
          if (err) return { count: 0, error: `${index + 1}번째 행: ${err}` };
        }
        const payload = rows.map((r) => ({
          owner_auth_uid: owner,
          start_date: r.start_date,
          payment_method_id: r.payment_method_id || null,
          category_id: r.category_id,
          title: r.title || null,
          total_amount: r.total_amount,
          total_count: r.total_count,
          start_installment: r.start_installment || 1,
          is_active: true,
        }));
        const { error } = await supabase.from("hh_installment").insert(payload);
        if (error) return { count: 0, error: error.message };
        const sum = rows.reduce((s, r) => s + r.total_amount, 0);
        sendLog("CREATE_HH_INSTALLMENT", `할부 ${rows.length}건 일괄 등록: 합계 ${sum}원`, { resource: "hh_installment" });
        return { count: rows.length };
      }}
      renderCells={(row, update, options) => [
        <input key="date" type="date" className={bulkCellInput} value={row.start_date} onChange={(e) => update({ start_date: e.target.value })} />,
        <select key="method" className={bulkSelectClass} value={row.payment_method_id} onChange={(e) => update({ payment_method_id: e.target.value })}>
          <option value="">선택</option>
          {options.methods.map((m) => (<option key={m.id} value={m.id}>{m.name}</option>))}
        </select>,
        <select key="cat" className={bulkSelectClass} value={row.category_id} onChange={(e) => update({ category_id: e.target.value })}>
          <option value="">선택</option>
          {options.categories.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
        </select>,
        <input key="title" className={bulkCellInput} value={row.title} placeholder="예: 노트북 구매" onChange={(e) => update({ title: e.target.value })} />,
        <AmountInput key="total" className={`${bulkCellInput} h-9 text-right tabular-nums`} value={row.total_amount} onValueChange={(n) => update({ total_amount: n })} placeholder="0" />,
        <input key="count" type="number" min={1} className={`${bulkCellInput} text-right tabular-nums`} value={row.total_count} onChange={(e) => update({ total_count: Math.max(1, parseInt(e.target.value || "1", 10) || 1) })} />,
        <input key="start" type="number" min={1} max={row.total_count} className={`${bulkCellInput} text-right tabular-nums`} value={row.start_installment} onChange={(e) => update({ start_installment: Math.max(1, parseInt(e.target.value || "1", 10) || 1) })} title={row.total_amount > 0 && row.total_count > 0 ? `월 ${installmentMonthly(row.total_amount, row.total_count).toLocaleString("ko-KR")}원` : undefined} />,
      ]}
    />
  );
}
