"use client";

import { Pencil } from "lucide-react";

import { sendLog } from "@/lib/log-client";
import type { HhAccount } from "@/lib/household/types";
import { AmountInput } from "@/components/household/amount-input";
import { HH_COL } from "@/components/household/hh-board";
import { BulkEntry, bulkCellInput, bulkSelectClass, todayLocal } from "@/components/household/bulk-entry";
import { findAccountId, looksLikeHeader, parseAmount, parseDate } from "@/lib/household/paste";

type Row = { txn_date: string; from_account_id: string; to_account_id: string; amount: number; memo: string };
type Options = { accounts: HhAccount[] };

export function TransferBulkForm() {
  return (
    <BulkEntry<Row, Options>
      title="통장이동 등록 (여러 건)"
      breadcrumbs={[{ label: "가계부" }, { label: "통장이동", href: "/dashboard/household/transfers" }, { label: "통장이동 등록" }]}
      backHref="/dashboard/household/transfers"
      listHref="/dashboard/household/transfers"
      hint={<><Pencil className="h-3.5 w-3.5" />출금계좌와 입금계좌는 서로 달라야 합니다. 한 줄에 한 건씩 입력하세요.</>}
      addLabel="이동 행 추가"
      columns={[
        { label: "날짜", width: HH_COL.standard },
        { label: "출금계좌" },
        { label: "입금계좌" },
        { label: "금액", width: HH_COL.standard, align: "right" },
        { label: "메모" },
      ]}
      loadOptions={async (supabase) => {
        await supabase.auth.getSession();
        const { data } = await supabase.from("hh_account").select("*").eq("is_active", true).order("sort_order").order("name");
        const accounts = (data ?? []) as HhAccount[];
        if (accounts.length < 2) return null;
        return { accounts };
      }}
      missingMastersMessage={<>통장이동을 등록하려면 계좌가 2개 이상 필요합니다. 설정에서 계좌를 추가하세요.</>}
      emptyRow={(prev) => ({ txn_date: prev?.txn_date ?? todayLocal(), from_account_id: prev?.from_account_id ?? "", to_account_id: "", amount: 0, memo: "" })}
      isEmpty={(r) => r.amount <= 0 && !r.from_account_id && !r.to_account_id && !r.memo}
      validate={(r) =>
        !r.from_account_id ? "출금계좌를 선택하세요." : !r.to_account_id ? "입금계좌를 선택하세요." : r.from_account_id === r.to_account_id ? "출금/입금 계좌가 같을 수 없습니다." : r.amount <= 0 ? "금액은 1원 이상이어야 합니다." : null
      }
      amountOf={(r) => r.amount}
      successMessage={(n) => `통장이동 ${n}건이 등록되었습니다.`}
      pasteHint={<>컬럼 순서: <b>날짜 · 출금계좌명 · 입금계좌명 · 금액 · 메모</b></>}
      parsePaste={(matrix, options) => {
        const body = matrix.length && looksLikeHeader(matrix[0], 3) ? matrix.slice(1) : matrix;
        let skipped = 0;
        const rows = body
          .map((c) => {
            const amount = parseAmount(c[3] ?? "");
            if (amount <= 0) { skipped++; return null; }
            return {
              txn_date: parseDate(c[0] ?? "") || todayLocal(),
              from_account_id: findAccountId(c[1] ?? "", options.accounts) ?? "",
              to_account_id: findAccountId(c[2] ?? "", options.accounts) ?? "",
              amount,
              memo: c[4] ?? "",
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);
        return { rows, skipped };
      }}
      onSubmit={async (supabase, rows, owner) => {
        const payload = rows.map((r) => ({
          owner_auth_uid: owner,
          type: "transfer" as const,
          source: "manual",
          txn_date: r.txn_date,
          amount: r.amount,
          from_account_id: r.from_account_id,
          to_account_id: r.to_account_id,
          memo: r.memo || null,
        }));
        const { error } = await supabase.from("hh_transaction").insert(payload);
        if (error) return { count: 0, error: error.message };
        const sum = rows.reduce((s, r) => s + r.amount, 0);
        sendLog("CREATE_HH_TRANSFER", `통장이동 ${rows.length}건 일괄 등록: 합계 ${sum}원`, { resource: "hh_transaction" });
        return { count: rows.length };
      }}
      renderCells={(row, update, options) => [
        <input key="date" type="date" className={bulkCellInput} value={row.txn_date} onChange={(e) => update({ txn_date: e.target.value })} />,
        <select key="from" className={bulkSelectClass} value={row.from_account_id} onChange={(e) => update({ from_account_id: e.target.value })}>
          <option value="">선택</option>
          {options.accounts.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
        </select>,
        <select key="to" className={bulkSelectClass} value={row.to_account_id} onChange={(e) => update({ to_account_id: e.target.value })}>
          <option value="">선택</option>
          {options.accounts.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
        </select>,
        <AmountInput key="amt" className={`${bulkCellInput} h-9 text-right tabular-nums`} value={row.amount} onValueChange={(n) => update({ amount: n })} placeholder="0" />,
        <input key="memo" className={bulkCellInput} value={row.memo} placeholder="이체 사유" onChange={(e) => update({ memo: e.target.value })} />,
      ]}
    />
  );
}
