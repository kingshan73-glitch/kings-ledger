"use client";

import { Pencil } from "lucide-react";

import { sendLog } from "@/lib/log-client";
import { matchMerchantCategory } from "@/lib/household/defaults";
import type { HhAccount, HhCategory, HhPaymentMethod, HhPerson } from "@/lib/household/types";
import { AmountInput } from "@/components/household/amount-input";
import { HH_COL } from "@/components/household/hh-board";
import { BulkEntry, bulkCellInput, bulkSelectClass, todayLocal } from "@/components/household/bulk-entry";
import { findAccountId, findCategoryId, findMethodId, looksLikeHeader, parseAmount, parseDate } from "@/lib/household/paste";

type Row = {
  txn_date: string;
  category_id: string;
  payment_method_id: string;
  account_id: string;
  amount: number;
  counterparty: string;
  person_id: string;
  memo: string;
};
type MerchantMap = { merchant_key: string; category_id: string | null }[];
type Options = { categories: HhCategory[]; methods: HhPaymentMethod[]; accounts: HhAccount[]; persons: HhPerson[]; merchantMap: MerchantMap };

export function ExpenseBulkForm() {
  return (
    <BulkEntry<Row, Options>
      title="지출 등록 (여러 건 · 일시불)"
      breadcrumbs={[{ label: "가계부" }, { label: "지출", href: "/dashboard/household/expenses" }, { label: "등록" }]}
      backHref="/dashboard/household/expenses"
      listHref="/dashboard/household/expenses"
      hint={<><Pencil className="h-3.5 w-3.5" />가맹점을 입력하면 카테고리가 자동 분류됩니다. 신용카드 지출은 카드대금 납부일에 계좌에서 빠집니다(출금계좌는 현금·체크만).</>}
      addLabel="지출 행 추가"
      columns={[
        { label: "날짜", width: HH_COL.standard },
        { label: "카테고리" },
        { label: "지불방식" },
        { label: "출금계좌" },
        { label: "금액", width: HH_COL.standard, align: "right" },
        { label: "가맹점" },
        { label: "인물(용돈)", width: HH_COL.standard },
        { label: "내역" },
      ]}
      loadOptions={async (supabase) => {
        await supabase.auth.getSession();
        const [catRes, mRes, accRes, perRes, mapRes] = await Promise.all([
          supabase.from("hh_category").select("*").eq("kind", "expense").eq("is_active", true).order("sort_order").order("name"),
          supabase.from("hh_payment_method").select("*").eq("is_active", true).order("sort_order").order("name"),
          supabase.from("hh_account").select("*").eq("is_active", true).order("sort_order").order("name"),
          supabase.from("hh_person").select("*").eq("is_active", true).order("sort_order").order("name"),
          supabase.from("hh_merchant_map").select("merchant_key,category_id"),
        ]);
        const categories = (catRes.data ?? []) as HhCategory[];
        const methods = (mRes.data ?? []) as HhPaymentMethod[];
        if (categories.length === 0 || methods.length === 0) return null;
        return {
          categories,
          methods,
          accounts: (accRes.data ?? []) as HhAccount[],
          persons: (perRes.data ?? []) as HhPerson[],
          merchantMap: (mapRes.data ?? []) as MerchantMap,
        };
      }}
      missingMastersMessage={
        <>지출을 등록하려면 먼저 <b>지출 카테고리</b>와 <b>결제수단</b>이 필요합니다. 가계부 &gt; 설정에서 만들어 주세요.</>
      }
      emptyRow={(prev) => ({ txn_date: prev?.txn_date ?? todayLocal(), category_id: "", payment_method_id: prev?.payment_method_id ?? "", account_id: prev?.account_id ?? "", amount: 0, counterparty: "", person_id: "", memo: "" })}
      isEmpty={(r) => r.amount <= 0 && !r.category_id && !r.counterparty && !r.memo}
      validate={(r) => (!r.category_id ? "카테고리를 선택하세요." : !r.payment_method_id ? "지불방식을 선택하세요." : r.amount <= 0 ? "금액은 1원 이상이어야 합니다." : null)}
      amountOf={(r) => r.amount}
      successMessage={(n) => `지출 ${n}건이 등록되었습니다.`}
      pasteHint={<>컬럼 순서: <b>날짜 · 카테고리명 · 지불방식명 · 출금계좌명 · 금액 · 가맹점 · 인물 · 내역</b> (카테고리 비우면 가맹점으로 자동분류)</>}
      parsePaste={(matrix, options) => {
        const body = matrix.length && looksLikeHeader(matrix[0], 4) ? matrix.slice(1) : matrix;
        let skipped = 0;
        const rows = body
          .map((c) => {
            const amount = parseAmount(c[4] ?? "");
            if (amount <= 0) { skipped++; return null; }
            const merchant = c[5] ?? "";
            let categoryId = findCategoryId(c[1] ?? "", options.categories) ?? "";
            if (!categoryId && merchant) categoryId = matchMerchantCategory(merchant.trim(), options.merchantMap) ?? "";
            const personId = options.persons.find((p) => p.name === (c[6] ?? "").trim())?.id ?? "";
            return {
              txn_date: parseDate(c[0] ?? "") || todayLocal(),
              category_id: categoryId,
              payment_method_id: findMethodId(c[2] ?? "", options.methods) ?? "",
              account_id: findAccountId(c[3] ?? "", options.accounts) ?? "",
              amount,
              counterparty: merchant,
              person_id: personId,
              memo: c[7] ?? "",
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);
        return { rows, skipped };
      }}
      onSubmit={async (supabase, rows, owner) => {
        const payload = rows.map((r) => ({
          owner_auth_uid: owner,
          type: "expense" as const,
          source: "manual",
          txn_date: r.txn_date,
          amount: r.amount,
          category_id: r.category_id,
          payment_method_id: r.payment_method_id,
          account_id: r.account_id || null,
          counterparty: r.counterparty || null,
          person_id: r.person_id || null,
          memo: r.memo || null,
        }));
        const { error } = await supabase.from("hh_transaction").insert(payload);
        if (error) return { count: 0, error: error.message };
        const sum = rows.reduce((s, r) => s + r.amount, 0);
        sendLog("CREATE_HH_EXPENSE", `지출 ${rows.length}건 일괄 등록: 합계 ${sum}원`, { resource: "hh_transaction" });
        return { count: rows.length };
      }}
      renderCells={(row, update, options) => [
        <input key="date" type="date" className={bulkCellInput} value={row.txn_date} onChange={(e) => update({ txn_date: e.target.value })} />,
        <select key="cat" className={bulkSelectClass} value={row.category_id} onChange={(e) => update({ category_id: e.target.value })}>
          <option value="">선택</option>
          {options.categories.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
        </select>,
        <select key="method" className={bulkSelectClass} value={row.payment_method_id} onChange={(e) => update({ payment_method_id: e.target.value })}>
          <option value="">선택</option>
          {options.methods.map((m) => (<option key={m.id} value={m.id}>{m.name}</option>))}
        </select>,
        <select key="acc" className={bulkSelectClass} value={row.account_id} onChange={(e) => update({ account_id: e.target.value })}>
          <option value="">없음</option>
          {options.accounts.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
        </select>,
        <AmountInput key="amt" className={`${bulkCellInput} h-9 text-right tabular-nums`} value={row.amount} onValueChange={(n) => update({ amount: n })} placeholder="0" />,
        <input
          key="cp"
          className={bulkCellInput}
          value={row.counterparty}
          placeholder="예: 스타벅스"
          onChange={(e) => update({ counterparty: e.target.value })}
          onBlur={(e) => {
            if (row.category_id) return;
            const guessed = matchMerchantCategory(e.target.value.trim(), options.merchantMap);
            if (guessed) update({ category_id: guessed });
          }}
        />,
        <select key="person" className={bulkSelectClass} value={row.person_id} onChange={(e) => update({ person_id: e.target.value })}>
          <option value="">해당 없음</option>
          {options.persons.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
        </select>,
        <input key="memo" className={bulkCellInput} value={row.memo} placeholder="상세 내역" onChange={(e) => update({ memo: e.target.value })} />,
      ]}
    />
  );
}
