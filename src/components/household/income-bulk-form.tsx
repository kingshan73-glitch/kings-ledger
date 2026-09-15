"use client";

import { Pencil } from "lucide-react";

import { sendLog } from "@/lib/log-client";
import type { HhAccount, HhCategory } from "@/lib/household/types";
import { AmountInput } from "@/components/household/amount-input";
import { HH_COL } from "@/components/household/hh-board";
import { BulkEntry, bulkCellInput, bulkSelectClass, todayLocal } from "@/components/household/bulk-entry";
import { findAccountId, findCategoryId, looksLikeHeader, parseAmount, parseDate } from "@/lib/household/paste";

type Row = { txn_date: string; category_id: string; account_id: string; amount: number; counterparty: string; memo: string };
type Options = { categories: HhCategory[]; accounts: HhAccount[] };

export function IncomeBulkForm() {
  return (
    <BulkEntry<Row, Options>
      title="수입 등록 (여러 건)"
      breadcrumbs={[{ label: "가계부" }, { label: "수입", href: "/dashboard/household/income" }, { label: "등록" }]}
      backHref="/dashboard/household/income"
      listHref="/dashboard/household/income"
      hint={<><Pencil className="h-3.5 w-3.5" />한 줄에 한 건씩 입력하세요. 아래 &lsquo;행 추가&rsquo;로 늘리고, 다 채우면 한 번에 등록됩니다.</>}
      addLabel="수입 행 추가"
      columns={[
        { label: "날짜", width: HH_COL.standard },
        { label: "항목" },
        { label: "입금계좌" },
        { label: "금액", width: HH_COL.standard, align: "right" },
        { label: "입금처" },
        { label: "메모" },
      ]}
      loadOptions={async (supabase) => {
        await supabase.auth.getSession();
        const [catRes, accRes] = await Promise.all([
          supabase.from("hh_category").select("*").eq("kind", "income").eq("is_active", true).order("sort_order").order("name"),
          supabase.from("hh_account").select("*").eq("is_active", true).order("sort_order").order("name"),
        ]);
        const categories = (catRes.data ?? []) as HhCategory[];
        const accounts = (accRes.data ?? []) as HhAccount[];
        if (categories.length === 0 || accounts.length === 0) return null;
        return { categories, accounts };
      }}
      missingMastersMessage={
        <>수입을 등록하려면 먼저 <b>수입 카테고리</b>와 <b>계좌</b>가 필요합니다. 가계부 &gt; 설정에서 만들어 주세요.</>
      }
      emptyRow={(prev) => ({ txn_date: prev?.txn_date ?? todayLocal(), category_id: "", account_id: prev?.account_id ?? "", amount: 0, counterparty: "", memo: "" })}
      isEmpty={(r) => r.amount <= 0 && !r.category_id && !r.counterparty && !r.memo}
      validate={(r) => (!r.category_id ? "항목(카테고리)을 선택하세요." : !r.account_id ? "입금계좌를 선택하세요." : r.amount <= 0 ? "금액은 1원 이상이어야 합니다." : null)}
      amountOf={(r) => r.amount}
      successMessage={(n) => `수입 ${n}건이 등록되었습니다.`}
      pasteHint={<>컬럼 순서: <b>날짜 · 항목(카테고리명) · 입금계좌명 · 금액 · 입금처 · 메모</b></>}
      parsePaste={(matrix, options) => {
        const body = matrix.length && looksLikeHeader(matrix[0], 3) ? matrix.slice(1) : matrix;
        let skipped = 0;
        const rows = body
          .map((c) => {
            const amount = parseAmount(c[3] ?? "");
            if (amount <= 0) { skipped++; return null; }
            return {
              txn_date: parseDate(c[0] ?? "") || todayLocal(),
              category_id: findCategoryId(c[1] ?? "", options.categories) ?? "",
              account_id: findAccountId(c[2] ?? "", options.accounts) ?? "",
              amount,
              counterparty: c[4] ?? "",
              memo: c[5] ?? "",
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);
        return { rows, skipped };
      }}
      onSubmit={async (supabase, rows, owner) => {
        const payload = rows.map((r) => ({
          owner_auth_uid: owner,
          type: "income" as const,
          source: "manual",
          txn_date: r.txn_date,
          amount: r.amount,
          category_id: r.category_id,
          account_id: r.account_id,
          counterparty: r.counterparty || null,
          memo: r.memo || null,
        }));
        const { error } = await supabase.from("hh_transaction").insert(payload);
        if (error) return { count: 0, error: error.message };
        const sum = rows.reduce((s, r) => s + r.amount, 0);
        sendLog("CREATE_HH_INCOME", `수입 ${rows.length}건 일괄 등록: 합계 ${sum}원`, { resource: "hh_transaction" });
        return { count: rows.length };
      }}
      renderCells={(row, update, options) => [
        <input key="date" type="date" className={bulkCellInput} value={row.txn_date} onChange={(e) => update({ txn_date: e.target.value })} />,
        <select key="cat" className={bulkSelectClass} value={row.category_id} onChange={(e) => update({ category_id: e.target.value })}>
          <option value="">선택</option>
          {options.categories.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
        </select>,
        <select key="acc" className={bulkSelectClass} value={row.account_id} onChange={(e) => update({ account_id: e.target.value })}>
          <option value="">선택</option>
          {options.accounts.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
        </select>,
        <AmountInput key="amt" className={`${bulkCellInput} h-9 text-right tabular-nums`} value={row.amount} onValueChange={(n) => update({ amount: n })} placeholder="0" />,
        <input key="cp" className={bulkCellInput} value={row.counterparty} placeholder="예: ○○회사 급여" onChange={(e) => update({ counterparty: e.target.value })} />,
        <input key="memo" className={bulkCellInput} value={row.memo} placeholder="상세 내역" onChange={(e) => update({ memo: e.target.value })} />,
      ]}
    />
  );
}
