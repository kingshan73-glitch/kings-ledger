"use client";

import Link from "next/link";
import { CalendarClock, ChevronDown, Pencil, PiggyBank, Plus, Sparkles, Terminal, Trash2, Users, Wallet, Tags, Smartphone, KeyRound, Copy } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  AccountPaymentDialog,
  CategoryDialog,
  PersonDialog,
  type AccountPaymentSave,
  type AccountPaymentTarget,
} from "@/components/household/master-dialogs";
import {
  ScheduledPaymentDialog,
  type ScheduledPaymentFormData,
} from "@/components/household/scheduled-payment-dialog";
import { BudgetTab } from "@/components/household/budget-tab";
import {
  ErrorState,
  LoadingState,
  PageShell,
} from "@/components/page-shell";
import { HhPageHeader } from "@/components/household/hh-page-header";
import { HH_COL, HH_CELL, HH_TABLE, tableMinWidth, colStyles } from "@/components/household/hh-board";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger, HH_TAB_SOLID } from "@/components/ui/tabs";
import { sendLog } from "@/lib/log-client";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import {
  DEFAULT_ACCOUNTS,
  DEFAULT_CARDS,
  DEFAULT_EXPENSE_CATEGORIES,
  DEFAULT_INCOME_CATEGORIES,
  DEFAULT_MERCHANT_MAP,
  DEFAULT_PERSONS,
} from "@/lib/household/defaults";
import { useMasking } from "@/components/masking-provider";
import { getOwnerUid, maskAccountNo, maskCardNo } from "@/lib/household/owner";
import { useHideInactiveAccounts } from "@/lib/household/account-visibility";
import {
  ACCOUNT_KIND_LABEL,
  PAYMENT_METHOD_KIND_LABEL,
  SCHEDULED_KIND_LABEL,
  type HhAccount,
  type HhCategory,
  type HhCategoryKind,
  type HhPaymentMethod,
  type HhPerson,
  type HhScheduledPayment,
} from "@/lib/household/types";

type IngestToken = { id: string; label: string | null; last_used_at: string | null; created_at: string };

// 문자수집 토큰: 클라이언트에서 안전 난수 생성 후 sha256 해시만 DB에 저장(원문은 1회만 표시).
function randomToken(): string {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function copyText(value: string) {
  await navigator.clipboard.writeText(value);
  toast.success("복사했습니다.");
}

export default function HouseholdSettingsPage() {
  const supabase = useMemo(() => createClient(), []);
  const { mask } = useMasking();
  const [persons, setPersons] = useState<HhPerson[]>([]);
  const [accounts, setAccounts] = useState<HhAccount[]>([]);
  const [categories, setCategories] = useState<HhCategory[]>([]);
  const [methods, setMethods] = useState<HhPaymentMethod[]>([]);
  const [scheduled, setScheduled] = useState<HhScheduledPayment[]>([]);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [tokens, setTokens] = useState<IngestToken[]>([]);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // 다이얼로그 상태
  const [personDialog, setPersonDialog] = useState<{ open: boolean; target: HhPerson | null }>({ open: false, target: null });
  const [accountDialog, setAccountDialog] = useState<{ open: boolean; target: AccountPaymentTarget }>({ open: false, target: null });
  // 비활성 계좌 숨기기 전역 설정(설계 89) — 여기서 켜고 끄되, 이 화면 목록에는 적용하지 않는다.
  const [hideInactiveAccounts, setHideInactiveAccounts] = useHideInactiveAccounts();
  // 이 화면 계좌정보 목록 전용 — 비활성 행을 접었다 폈다. 기본 접힘. (설계 118)
  const [showInactiveEntries, setShowInactiveEntries] = useState(false);
  const [categoryDialog, setCategoryDialog] = useState<{ open: boolean; target: HhCategory | null; kind: HhCategoryKind }>({ open: false, target: null, kind: "expense" });
  const [scheduledDialog, setScheduledDialog] = useState<{ open: boolean; target: HhScheduledPayment | null }>({ open: false, target: null });

  const personName = useCallback(
    (id: string | null) => persons.find((p) => p.id === id)?.name ?? "-",
    [persons]
  );
  const accountName = useCallback(
    (id: string | null) => accounts.find((a) => a.id === id)?.name ?? "-",
    [accounts]
  );

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(false);
    await supabase.auth.getSession();

    const [pRes, aRes, cRes, mRes, sRes, tRes, balRes] = await Promise.all([
      supabase.from("hh_person").select("*").order("sort_order").order("name"),
      supabase.from("hh_account").select("*").order("sort_order").order("name"),
      supabase.from("hh_category").select("*").order("kind").order("sort_order").order("name"),
      supabase.from("hh_payment_method").select("*").order("sort_order").order("name"),
      supabase.from("hh_scheduled_payment").select("*").order("is_active", { ascending: false }).order("pay_day"),
      supabase.from("hh_ingest_token").select("id, label, last_used_at, created_at").order("created_at", { ascending: false }),
      supabase.from("hh_account_balance").select("account_id, current_balance"),
    ]);

    // balRes 가 빠져 있었다 — 실패하면 계좌 잔액 컬럼이 개설시점 금액으로 보인다.
    // tRes(문자수집 토큰) 실패는 토큰 목록이 비어 보여 재발급을 유도한다.
    const failed = [pRes, aRes, cRes, mRes, sRes, tRes, balRes].find((r) => r.error);
    if (failed) {
      console.error("가계부 마스터 조회 실패:", failed.error);
      toast.error("마스터 데이터를 불러오지 못했습니다.");
      setError(true);
      setLoading(false);
      return;
    }
    setPersons((pRes.data ?? []) as HhPerson[]);
    setAccounts((aRes.data ?? []) as HhAccount[]);
    setCategories((cRes.data ?? []) as HhCategory[]);
    setMethods((mRes.data ?? []) as HhPaymentMethod[]);
    setScheduled((sRes.data ?? []) as HhScheduledPayment[]);
    setTokens((tRes.data ?? []) as IngestToken[]);
    const balMap: Record<string, number> = {};
    for (const b of (balRes.data ?? []) as { account_id: string; current_balance: number }[]) balMap[b.account_id] = b.current_balance;
    setBalances(balMap);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchData();
  }, [fetchData]);

  // ── 공통 저장/삭제 ──
  const insertWithOwner = async (table: string, data: Record<string, unknown>) => {
    const owner = await getOwnerUid(supabase);
    if (!owner) {
      toast.error("로그인 정보를 확인할 수 없습니다.");
      return false;
    }
    const { error: err } = await supabase.from(table).insert({ ...data, owner_auth_uid: owner });
    if (err) {
      toast.error(`등록 실패: ${err.message}`);
      return false;
    }
    return true;
  };

  const updateRow = async (table: string, id: string, data: Record<string, unknown>) => {
    const { error: err } = await supabase.from(table).update(data).eq("id", id);
    if (err) {
      toast.error(`수정 실패: ${err.message}`);
      return false;
    }
    return true;
  };

  // insert 후 새 행의 id 를 돌려준다(계좌 등록 직후 연결 결제수단을 만들 때 필요).
  const insertReturningId = async (table: string, data: Record<string, unknown>): Promise<string | null> => {
    const owner = await getOwnerUid(supabase);
    if (!owner) {
      toast.error("로그인 정보를 확인할 수 없습니다.");
      return null;
    }
    const { data: row, error: err } = await supabase
      .from(table)
      .insert({ ...data, owner_auth_uid: owner })
      .select("id")
      .single();
    if (err || !row) {
      toast.error(`등록 실패: ${err?.message ?? "알 수 없는 오류"}`);
      return null;
    }
    return (row as { id: string }).id;
  };

  // 계좌·카드 통합 저장 (설계: docs/household/31).
  // 은행계좌는 hh_account 저장 + '결제수단' 체크 시 연결된 hh_payment_method 를 생성/동기화한다.
  const saveAccountPayment = async (data: AccountPaymentSave) => {
    const target = accountDialog.target;

    // 카드·기타 결제수단: hh_payment_method 단독 저장
    if (data.mode === "card") {
      const cardTarget = target?.type === "card" ? target.method : null;
      const ok = cardTarget
        ? await updateRow("hh_payment_method", cardTarget.id, data.method)
        : await insertWithOwner("hh_payment_method", data.method);
      if (ok) {
        toast.success(cardTarget ? "수정되었습니다." : "등록되었습니다.");
        await fetchData();
      }
      return;
    }

    // 은행계좌
    const accTarget = target?.type === "account" ? target.account : null;
    let accountId: string | null;
    if (accTarget) {
      const ok = await updateRow("hh_account", accTarget.id, data.account);
      if (!ok) return;
      accountId = accTarget.id;
    } else {
      accountId = await insertReturningId("hh_account", data.account);
      if (!accountId) return;
    }

    // 결제수단 동기화
    const linked = target?.type === "account" ? target.linkedMethod : null;
    if (data.asPayment && data.payment) {
      const pm = {
        name: data.account.name,
        kind: data.payment.kind,
        person_id: data.account.person_id,
        linked_account_id: accountId,
        billing_day: data.payment.billing_day,
        card_no: data.payment.card_no,
        card_expiry: data.payment.card_expiry,
        is_active: true,
        sort_order: 0,
      };
      if (linked) await updateRow("hh_payment_method", linked.id, pm);
      else await insertWithOwner("hh_payment_method", pm);
    } else if (linked && linked.is_active) {
      // 체크 해제 → 과거 거래 보존 위해 삭제 대신 비활성화
      await updateRow("hh_payment_method", linked.id, { is_active: false });
    }

    toast.success(accTarget ? "수정되었습니다." : "등록되었습니다.");
    await fetchData();
  };

  // 삭제 → 연결된 거래가 있으면(FK RESTRICT) 데이터 손실 없이 '보관(숨김)'을 제안.
  // 보관 = is_active=false. 신규 입력 드롭다운에서 숨겨지되 과거 거래·통계는 그대로 유지된다.
  const deleteRow = async (table: string, id: string, label: string) => {
    if (!confirm(`'${label}' 항목을 삭제하시겠습니까?`)) return;
    const { error: err } = await supabase.from(table).delete().eq("id", id);
    if (!err) {
      toast.success("삭제되었습니다.");
      await fetchData();
      return;
    }
    // 23503 = FK 위반(다른 거래가 참조 중). 삭제 대신 보관을 제안한다.
    if (err.code === "23503") {
      if (confirm(`'${label}'은(는) 이미 거래에서 사용 중이라 삭제할 수 없습니다.\n대신 '보관'(목록·신규 입력에서 숨김, 과거 기록은 유지)하시겠습니까?`)) {
        const { error: uErr } = await supabase.from(table).update({ is_active: false }).eq("id", id);
        if (uErr) {
          toast.error(`보관 실패: ${uErr.message}`);
          return;
        }
        toast.success("보관되었습니다. (수정 화면에서 다시 활성화할 수 있습니다)");
        await fetchData();
      }
      return;
    }
    toast.error(`삭제 실패: ${err.message}`);
  };

  // 목록에서 바로 '결제수단 등록/해제' (펜 화면 안 열고 인라인 토글). 설계: docs/household/31.
  // 등록 = 이 계좌에 연결된 체크카드 결제수단 생성(또는 비활성 결제수단 재활성).
  const registerAsPayment = async (account: HhAccount, linked: HhPaymentMethod | null) => {
    let ok = false;
    if (linked) {
      ok = await updateRow("hh_payment_method", linked.id, { is_active: true });
    } else {
      ok = await insertWithOwner("hh_payment_method", {
        name: account.name,
        kind: "check",
        person_id: account.person_id,
        linked_account_id: account.id,
        billing_day: null,
        card_no: null,
        card_expiry: null,
        is_active: true,
        sort_order: 0,
      });
    }
    if (ok) {
      toast.success("결제수단으로 등록했습니다.");
      await fetchData();
    }
  };

  // 해제 = 과거 거래 보존 위해 삭제 대신 비활성화.
  const unregisterPayment = async (linked: HhPaymentMethod) => {
    const ok = await updateRow("hh_payment_method", linked.id, { is_active: false });
    if (ok) {
      toast.success("결제수단에서 해제했습니다.");
      await fetchData();
    }
  };

  // ── 문자수집 토큰 ──
  const issueToken = async () => {
    const owner = await getOwnerUid(supabase);
    if (!owner) {
      toast.error("로그인 정보를 확인할 수 없습니다.");
      return;
    }
    const label = (window.prompt("토큰 이름(예: 내 폰)", "내 폰") ?? "").trim() || null;
    const raw = randomToken();
    const token_hash = await sha256Hex(raw);
    const { error: err } = await supabase.from("hh_ingest_token").insert({ owner_auth_uid: owner, token_hash, label });
    if (err) {
      toast.error(`발급 실패: ${err.message}`);
      return;
    }
    setIssuedToken(raw); // 1회만 표시
    sendLog("CREATE_HH_INGEST_TOKEN", `문자수집 토큰 발급: ${label ?? "(이름없음)"}`, { resource: "hh_ingest_token" });
    await fetchData();
  };

  const revokeToken = async (id: string, label: string | null) => {
    if (!confirm(`'${label ?? "토큰"}'을(를) 폐기하시겠습니까? 이 토큰을 쓰던 폰은 더 이상 문자를 보낼 수 없습니다.`)) return;
    const { error: err } = await supabase.from("hh_ingest_token").delete().eq("id", id);
    if (err) {
      toast.error(`폐기 실패: ${err.message}`);
      return;
    }
    toast.success("토큰을 폐기했습니다.");
    await fetchData();
  };

  // ── 기본값 생성 ──
  const seedDefaults = async () => {
    const owner = await getOwnerUid(supabase);
    if (!owner) {
      toast.error("로그인 정보를 확인할 수 없습니다.");
      return;
    }
    const tasks: PromiseLike<{ error: unknown }>[] = [];

    const existingPersons = new Set(persons.map((p) => p.name));
    const newPersons = DEFAULT_PERSONS.filter((n) => !existingPersons.has(n)).map((name, i) => ({
      owner_auth_uid: owner,
      name,
      sort_order: i,
      is_active: true,
    }));
    if (newPersons.length) tasks.push(supabase.from("hh_person").insert(newPersons));

    const existingCats = new Set(categories.map((c) => `${c.kind}:${c.name}`));
    const newCats = [
      ...DEFAULT_INCOME_CATEGORIES.map((name, i) => ({ name, kind: "income" as const, sort: i })),
      ...DEFAULT_EXPENSE_CATEGORIES.map((name, i) => ({ name, kind: "expense" as const, sort: i })),
    ]
      .filter((c) => !existingCats.has(`${c.kind}:${c.name}`))
      .map((c) => ({
        owner_auth_uid: owner,
        name: c.name,
        kind: c.kind,
        is_fixed: false,
        sort_order: c.sort,
        is_active: true,
      }));
    if (newCats.length) tasks.push(supabase.from("hh_category").insert(newCats));

    // 현금 결제수단 기본 1개
    if (!methods.some((m) => m.kind === "cash")) {
      tasks.push(
        supabase.from("hh_payment_method").insert({
          owner_auth_uid: owner,
          name: "현금",
          kind: "cash",
          is_active: true,
          sort_order: 0,
        })
      );
    }

    let failed = false;
    if (tasks.length) {
      const results = await Promise.all(tasks);
      failed = results.some((r) => (r as { error?: unknown }).error);
    }

    // 샘플 계좌·카드(defaults.ts DEFAULT_ACCOUNTS·DEFAULT_CARDS) — 인물 id 가 필요하므로 인물 생성 뒤에 조회한다.
    // 이름이 같은 계좌·결제수단이 이미 있으면 건너뛴다(두 번 눌러도 중복 생성 없음).
    const { data: personRows } = await supabase.from("hh_person").select("id,name").eq("owner_auth_uid", owner);
    const personIdByName = new Map((personRows ?? []).map((p) => [p.name as string, p.id as string]));
    const existingAccountNames = new Set(accounts.map((a) => a.name));
    const newAccounts = DEFAULT_ACCOUNTS.filter((a) => !existingAccountNames.has(a.name)).map((a, i) => ({
      owner_auth_uid: owner,
      name: a.name,
      bank: a.bank,
      account_no: null,
      person_id: personIdByName.get(a.person) ?? null,
      kind: a.kind,
      opening_balance: 0,
      sort_order: i,
      is_active: true,
    }));
    let seededAccounts = 0;
    if (newAccounts.length) {
      const { error: accErr } = await supabase.from("hh_account").insert(newAccounts);
      if (accErr) failed = true;
      else seededAccounts = newAccounts.length;
    }
    const { data: accountRows } = await supabase.from("hh_account").select("id,name").eq("owner_auth_uid", owner);
    const accountIdByName = new Map((accountRows ?? []).map((a) => [a.name as string, a.id as string]));
    const existingMethodNames = new Set(methods.map((m) => m.name));
    const newCards = DEFAULT_CARDS.filter((c) => !existingMethodNames.has(c.name)).map((c, i) => ({
      owner_auth_uid: owner,
      name: c.name,
      kind: c.kind,
      person_id: personIdByName.get(c.person) ?? null,
      linked_account_id: accountIdByName.get(c.linkedAccount) ?? null,
      billing_day: c.billingDay,
      card_no: c.cardNo,
      card_expiry: null,
      is_active: true,
      sort_order: i + 1,
    }));
    let seededCards = 0;
    if (newCards.length) {
      const { error: cardErr } = await supabase.from("hh_payment_method").insert(newCards);
      if (cardErr) failed = true;
      else seededCards = newCards.length;
    }

    // 가맹점 → 카테고리 기본 매핑 시드 (카테고리 id 가 필요하므로 마스터 생성 후 조회)
    const { data: expCats } = await supabase
      .from("hh_category")
      .select("id,name")
      .eq("owner_auth_uid", owner)
      .eq("kind", "expense");
    const catIdByName = new Map((expCats ?? []).map((c) => [c.name as string, c.id as string]));
    const mapRows = DEFAULT_MERCHANT_MAP.map((m) => ({
      owner_auth_uid: owner,
      merchant_key: m.key,
      category_id: catIdByName.get(m.category) ?? null,
    })).filter((r) => r.category_id !== null);

    let mapInserted = 0;
    if (mapRows.length) {
      const { data: ins, error: mapErr } = await supabase
        .from("hh_merchant_map")
        .upsert(mapRows, { onConflict: "owner_auth_uid,merchant_key", ignoreDuplicates: true })
        .select("id");
      if (mapErr) failed = true;
      else mapInserted = ins?.length ?? 0;
    }

    if (!tasks.length && !mapInserted && !seededAccounts && !seededCards) {
      toast.info("이미 기본값이 모두 있습니다.");
      return;
    }
    if (failed) {
      toast.error("기본값 생성 중 일부 실패했습니다.");
    } else {
      toast.success("기본 인물·계좌·카드·카테고리·가맹점 매핑을 생성했습니다.");
      sendLog("CREATE_HOUSEHOLD_DEFAULTS", "가계부 기본 마스터 생성", { resource: "household" });
    }
    await fetchData();
  };

  if (loading) {
    return (
      <PageShell>
        <HhPageHeader title="설정" description="계좌·카테고리·결제수단·인물 등 가계부 전반에서 쓰는 기준 데이터를 관리합니다." />
        <LoadingState label="마스터 데이터를 불러오는 중..." />
      </PageShell>
    );
  }

  if (error) {
    return (
      <PageShell>
        <HhPageHeader title="설정" description="계좌·카테고리·결제수단·인물 등 가계부 전반에서 쓰는 기준 데이터를 관리합니다." />
        <ErrorState onRetry={() => void fetchData()} />
      </PageShell>
    );
  }

  const incomeCats = categories.filter((c) => c.kind === "income");
  const expenseCats = categories.filter((c) => c.kind === "expense");

  // ── 계좌정보 통합 목록 (설계: docs/household/31) ──
  // 은행계좌에 딸린 체크카드 결제수단은 계좌 행에 배지로 흡수하고,
  // 계좌 없는 결제수단(신용카드·할부·현금 등)은 독립 행으로 보여준다.
  const accountIdSet = new Set(accounts.map((a) => a.id));
  const methodByAccount = new Map<string, HhPaymentMethod>();
  const absorbedMethodIds = new Set<string>();
  for (const m of methods) {
    if (m.kind === "check" && m.linked_account_id && accountIdSet.has(m.linked_account_id) && !methodByAccount.has(m.linked_account_id)) {
      methodByAccount.set(m.linked_account_id, m);
      absorbedMethodIds.add(m.id);
    }
  }
  const cardRows = methods.filter((m) => !absorbedMethodIds.has(m.id));
  const hasAnyEntry = accounts.length > 0 || cardRows.length > 0;

  // 비활성 계좌·카드는 목록 맨 아래로 내리고 기본으로 접는다(팀장 요청 2026-08-01, 설계 118).
  // ⚠️ 설계 89 는 "설정 화면에서까지 숨기면 되살릴 경로가 사라진다"는 이유로 전량 노출이었다 —
  //    그래서 숨기되 없애지 않는다: 아래 '비활성 N개 보기' 로 언제든 펼칠 수 있다.
  //    전역 설정(hideInactiveAccounts, 다른 화면 적용)과는 별개다.
  // 정렬은 활성 우선만 하고 그 안의 순서는 조회 순서를 그대로 둔다(sort 는 안정 정렬).
  const activeAccounts = accounts.filter((a) => a.is_active);
  const inactiveAccounts = accounts.filter((a) => !a.is_active);
  const activeCardRows = cardRows.filter((m) => m.is_active);
  const inactiveCardRows = cardRows.filter((m) => !m.is_active);
  const inactiveEntryCount = inactiveAccounts.length + inactiveCardRows.length;

  // 행 렌더러를 함수로 뽑는다 — 활성/비활성을 4블록(활성계좌→활성카드→비활성계좌→비활성카드)으로
  // 나눠 그려야 '비활성은 전부 맨 아래'가 되는데, JSX 를 네 번 복사하지 않기 위함이다. (설계 118)
  const renderAccountRow = (a: HhAccount) => {
    const linked = methodByAccount.get(a.id) ?? null;
    return (
      <tr key={a.id} className={ROW}>
        <td className={cn(TD, "font-medium")} title={mask("owner_name", a.name)}><span className={`block ${HH_CELL.wrapText}`}>{mask("owner_name", a.name)}</span></td>
        <td className={cn(TD, "text-muted-foreground")}>{a.bank ?? "-"}</td>
        <td className={cn(TD, "whitespace-nowrap")}>{mask("name", personName(a.person_id))}</td>
        <td className={cn(TD, "whitespace-nowrap")}>{ACCOUNT_KIND_LABEL[a.kind]}</td>
        <td className={cn(TD, HH_CELL.wrapText, "tabular-nums")} title={maskAccountNo(a.account_no)}>{maskAccountNo(a.account_no)}</td>
        <td className={TD}>
          {linked && linked.is_active ? (
            <div className="flex items-center gap-1.5">
              <Badge variant="secondary">{PAYMENT_METHOD_KIND_LABEL[linked.kind]}</Badge>
              <Button
                variant="ghost"
                size="sm"
                className="h-9 px-2.5 text-xs text-muted-foreground md:h-7 md:px-2"
                onClick={() => void unregisterPayment(linked)}
              >
                해제
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-9 px-2.5 text-xs md:h-7 md:px-2"
              onClick={() => void registerAsPayment(a, linked)}
            >
              <Plus className="h-3.5 w-3.5" /> 등록
            </Button>
          )}
        </td>
        <td className={cn(TD, "truncate text-right tabular-nums font-medium")}>{mask("amount", `${(balances[a.id] ?? a.opening_balance).toLocaleString("ko-KR")}원`)}</td>
        <td className={TD}>{a.is_active ? <Badge>활성</Badge> : <Badge variant="secondary">비활성</Badge>}</td>
        <RowActions
          onEdit={() => setAccountDialog({ open: true, target: { type: "account", account: a, linkedMethod: linked } })}
          onDelete={() => void deleteRow("hh_account", a.id, a.name)}
        />
      </tr>
    );
  };
  const renderCardRow = (m: HhPaymentMethod) => (
    <tr key={m.id} className={ROW}>
      <td className={cn(TD, "font-medium")} title={mask("owner_name", m.name)}><span className={`block ${HH_CELL.wrapText}`}>{mask("owner_name", m.name)}</span></td>
      <td className={cn(TD, "text-muted-foreground")}>-</td>
      <td className={cn(TD, "whitespace-nowrap")}>{mask("name", personName(m.person_id))}</td>
      <td className={cn(TD, "whitespace-nowrap")}>{PAYMENT_METHOD_KIND_LABEL[m.kind]}</td>
      <td className={cn(TD, HH_CELL.wrapText, "tabular-nums")} title={m.kind === "cash" ? "-" : maskCardNo(m.card_no)}>{m.kind === "cash" ? "-" : maskCardNo(m.card_no)}</td>
      <td className={TD}>
        <Badge variant="secondary">{PAYMENT_METHOD_KIND_LABEL[m.kind]}</Badge>
      </td>
      <td className={cn(TD, "text-right tabular-nums text-muted-foreground")}>-</td>
      <td className={TD}>{m.is_active ? <Badge>활성</Badge> : <Badge variant="secondary">비활성</Badge>}</td>
      <RowActions
        onEdit={() => setAccountDialog({ open: true, target: { type: "card", method: m } })}
        onDelete={() => void deleteRow("hh_payment_method", m.id, m.name)}
      />
    </tr>
  );
  const ingestUrl = typeof window !== "undefined" ? `${window.location.origin}/api/household/inbox/sms` : "/api/household/inbox/sms";
  const tokenHeader = `X-Ingest-Token: ${issuedToken ?? "발급받은_토큰"}`;
  const macroDroidBody = "[sms_message]";
  const jsonBody = `{"text":"[sms_message]","sender":"[sms_sender]"}`;

  return (
    <PageShell>
      <HhPageHeader
        title="설정"
        description="계좌·카테고리·결제수단·인물 등 가계부 전반에서 쓰는 기준 데이터를 관리합니다."
        actions={
          <>
            {/* 사이드바에서 옮겨 온 자리(설계 140) — 매일 쓰는 화면이 아니라 설정 안에 둔다. */}
            <Button variant="outline" asChild>
              <Link href="/dashboard/household/claude-setup">
                <Terminal className="h-4 w-4" />
                클로드코드 설치
              </Link>
            </Button>
            <Button variant="outline" onClick={() => void seedDefaults()}>
              <Sparkles className="h-4 w-4" />
              기본값 생성
            </Button>
          </>
        }
      />

      <Tabs defaultValue="accounts">
        {/* overflow-x-auto 단독이면 overflow-y가 auto로 승격돼 1px 초과에도 세로 스크롤바(▲▼)가 생긴다 → overflow-y-hidden 병기. */}
        <div className="-mx-4 overflow-x-auto overflow-y-hidden px-4 md:mx-0 md:px-0">
          <TabsList className="min-w-max">
            <TabsTrigger value="accounts" className={HH_TAB_SOLID}>
              <Wallet className="h-4 w-4" /> 계좌정보
            </TabsTrigger>
            <TabsTrigger value="categories" className={HH_TAB_SOLID}>
              <Tags className="h-4 w-4" /> 지출항목 분류
            </TabsTrigger>
            <TabsTrigger value="persons" className={HH_TAB_SOLID}>
              <Users className="h-4 w-4" /> 인물
            </TabsTrigger>
            <TabsTrigger value="scheduled" className={HH_TAB_SOLID}>
              <CalendarClock className="h-4 w-4" /> 정기지출
            </TabsTrigger>
            <TabsTrigger value="budget" className={HH_TAB_SOLID}>
              <PiggyBank className="h-4 w-4" /> 예산
            </TabsTrigger>
            <TabsTrigger value="ingest" className={HH_TAB_SOLID}>
              <Smartphone className="h-4 w-4" /> 문자수집
            </TabsTrigger>
            {/* '개선사항' 탭은 대메뉴 '시스템개선'(/dashboard/household/system)으로 옮겼다.
                두 곳에 같은 게 있으면 어느 쪽이 최신인지 헷갈린다 — 팀장 결정(2026-08-09, 설계 157). */}
          </TabsList>
        </div>

        {/* ───── 계좌·카드 (통합) ───── */}
        <TabsContent value="accounts" className="space-y-3 pt-4">
          {/* 비활성 계좌 숨기기(설계 89) — 이 전역 토글은 '다른 화면'에만 적용된다.
              아래 계좌정보 목록은 이 토글과 무관하게, 비활성 행을 맨 아래로 내리고 기본으로 접는다(설계 118).
              접기이지 감추기가 아니다 — 표 아래 '비활성 N개 보기' 로 언제든 펼쳐 되살릴 수 있다. */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card/85 px-4 py-3 shadow-sm">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">비활성 계좌 숨기기</p>
              <p className="text-xs text-muted-foreground">
                켜면 다른 화면의 계좌 목록·필터·선택창에서 비활성 계좌가 빠집니다. 이미 등록된 거래가 쓰고 있는 계좌명은 그대로 보입니다. 아래 계좌정보 목록은 이 설정과 무관하게 비활성 항목을 맨 아래로 모아 접어 두며, 표 아래 ‘비활성 N개 보기’로 펼칠 수 있습니다.
              </p>
            </div>
            <Button
              variant={hideInactiveAccounts ? "default" : "outline"}
              size="sm"
              onClick={() => setHideInactiveAccounts(!hideInactiveAccounts)}
            >
              {hideInactiveAccounts ? "숨기는 중" : "모두 보이는 중"}
            </Button>
          </div>
          <div className="flex justify-end">
            <Button onClick={() => setAccountDialog({ open: true, target: null })}>
              <Plus className="h-4 w-4" /> 계좌·카드 등록
            </Button>
          </div>
          {!hasAnyEntry ? (
            <EmptyHint text="등록된 계좌·카드가 없습니다. '계좌·카드 등록' 또는 '기본값 생성'으로 시작하세요." />
          ) : (
            <SimpleTable
              head={[
                // 열 폭 = 내용별(설계 122). 괄호 안은 실측 필요폭(measure_table_content.mts).
                { label: "이름", width: HH_COL.x4wide },               // 가장 긴 카드명(235)까지 한 줄에 — 표 합계 1192 로 1200 이내(설계 125)
                { label: "은행/카드사", width: HH_COL.standard },      // 82.8 (헤더 52.8)
                { label: "명의", width: HH_COL.short },                // 61.1
                { label: "종류", width: HH_COL.short },                // 71.5
                { label: "번호", width: HH_COL.xxwide },                                     // 142.2 — 계좌번호 길이가 은행마다 다르다
                { label: "결제수단", width: HH_COL.wide },             // 129.7
                { label: "현재잔액", align: "right", width: HH_COL.standard }, // 99.5
                { label: "상태", width: HH_COL.short },                // 70.2
                { label: "", width: HH_COL.short },                    // 수정·삭제 아이콘 (86.3 → 아이콘만 남김)
              ]}
            >
              {/* 렌더 순서 = 활성 계좌 → 활성 카드 → (펼쳤을 때) 비활성 계좌 → 비활성 카드.
                  ⚠️ 계좌 블록·카드 블록을 각각 활성/비활성으로만 나누면 **비활성 계좌가 활성 카드보다 위**에
                     남는다(실화면 검증에서 잡힘) — 팀장 요청은 '비활성은 전부 맨 아래'다. (설계 118) */}
              {activeAccounts.map(renderAccountRow)}
              {activeCardRows.map(renderCardRow)}
              {showInactiveEntries ? inactiveAccounts.map(renderAccountRow) : null}
              {showInactiveEntries ? inactiveCardRows.map(renderCardRow) : null}
              {/* 비활성 행 펼침/접기 — 기본은 접힘. 이 줄이 있어야 비활성 계좌를 되살릴 경로가 남는다(설계 89 우려 해소, 설계 118). */}
              {inactiveEntryCount > 0 ? (
                <tr>
                  <td colSpan={9} className="px-3 py-2 text-center">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 text-xs text-muted-foreground"
                      onClick={() => setShowInactiveEntries((v) => !v)}
                    >
                      {showInactiveEntries ? `비활성 ${inactiveEntryCount}개 접기` : `비활성 ${inactiveEntryCount}개 보기`}
                    </Button>
                  </td>
                </tr>
              ) : null}
            </SimpleTable>
          )}
        </TabsContent>

        {/* ───── 카테고리 ───── */}
        <TabsContent value="categories" className="space-y-5 pt-4">
          <CategoryBlock
            title="수입 카테고리"
            cats={incomeCats}
            onAdd={() => setCategoryDialog({ open: true, target: null, kind: "income" })}
            onEdit={(c) => setCategoryDialog({ open: true, target: c, kind: c.kind })}
            onDelete={(c) => void deleteRow("hh_category", c.id, c.name)}
          />
          <CategoryBlock
            title="지출 카테고리"
            cats={expenseCats}
            onAdd={() => setCategoryDialog({ open: true, target: null, kind: "expense" })}
            onEdit={(c) => setCategoryDialog({ open: true, target: c, kind: c.kind })}
            onDelete={(c) => void deleteRow("hh_category", c.id, c.name)}
          />
        </TabsContent>

        {/* ───── 인물 ───── */}
        <TabsContent value="persons" className="space-y-3 pt-4">
          <div className="flex justify-end">
            <Button onClick={() => setPersonDialog({ open: true, target: null })}>
              <Plus className="h-4 w-4" /> 인물 등록
            </Button>
          </div>
          {persons.length === 0 ? (
            <EmptyHint text="등록된 인물이 없습니다." />
          ) : (
            <SimpleTable head={[
              // 열 폭 = 내용별(설계 122). 괄호 안은 실측 필요폭.
              { label: "이름", width: HH_COL.short },    // 61.1
              { label: "표시순서", width: HH_COL.tight }, // 내용은 숫자 1자리(39.4)지만 헤더 '표시순서'(70.9)가 하한
              { label: "상태", width: HH_COL.short },     // 70.2
              { label: "", width: HH_COL.short },         // 수정·삭제 아이콘
            ]}>
              {persons.map((p) => (
                <tr key={p.id} className={ROW}>
                  <td className={cn(TD, "font-medium")}>{mask("name", p.name)}</td>
                  <td className={cn(TD, "tabular-nums")}>{p.sort_order}</td>
                  <td className={TD}>{p.is_active ? <Badge>활성</Badge> : <Badge variant="secondary">비활성</Badge>}</td>
                  <RowActions
                    onEdit={() => setPersonDialog({ open: true, target: p })}
                    onDelete={() => void deleteRow("hh_person", p.id, p.name)}
                  />
                </tr>
              ))}
            </SimpleTable>
          )}
        </TabsContent>

        {/* ───── 정기지출 ───── */}
        <TabsContent value="scheduled" className="space-y-3 pt-4">
          <div className="flex justify-end">
            <Button onClick={() => setScheduledDialog({ open: true, target: null })}>
              <Plus className="h-4 w-4" /> 정기지출 등록
            </Button>
          </div>
          {scheduled.length === 0 ? (
            <EmptyHint text="등록된 정기지출이 없습니다. 보험·통신·관리비·적금 등을 등록하면 현금흐름 예측에 반영됩니다." />
          ) : (
            <SimpleTable
              head={[
                // 열 폭 = 내용별(설계 122). 괄호 안은 실측 필요폭.
                { label: "이름", width: HH_COL.xxwide },                  // 정기지출명이 160 에서 꺾였다(필요 184, 설계 125)
                { label: "종류", width: HH_COL.short },                   // 71.5
                { label: "방향", width: HH_COL.short },                   // 70.2
                { label: "금액", align: "right", width: HH_COL.standard }, // 98.1
                { label: "주기", width: HH_COL.short },                   // 50.8
                { label: "납부일", width: HH_COL.short },                 // 59.2
                // 계좌 — standard(112)에서 '카카오페이(김하늘)'(92)가 두 줄로 꺾였다(실측 2026-08-09).
                // 표 합계 960 → 984 로 여유가 크다(상한 1200).
                { label: "계좌", width: HH_COL.wide },
                { label: "상태", width: HH_COL.short },                   // 70.2
                { label: "", width: HH_COL.short },                       // 수정·삭제 아이콘
              ]}
            >
              {scheduled.map((sp) => (
                <tr key={sp.id} className={ROW}>
                  <td className={cn(TD, "font-medium")}>{sp.title}</td>
                  <td className={TD}>{SCHEDULED_KIND_LABEL[sp.kind]}</td>
                  <td className={TD}>{sp.direction === "in" ? <Badge variant="secondary">수입</Badge> : <Badge variant="secondary">지출</Badge>}</td>
                  <td className={cn(TD, "truncate text-right tabular-nums")}>{sp.amount != null ? mask("expense_amount", `${sp.amount.toLocaleString("ko-KR")}원`) : "-"}</td>
                  <td className={TD}>{sp.frequency === "monthly" ? "매월" : sp.frequency === "weekly" ? "매주" : "격월"}</td>
                  <td className={TD}>{sp.pay_day != null ? (sp.frequency === "weekly" ? `${["일", "월", "화", "수", "목", "금", "토"][sp.pay_day] ?? sp.pay_day}요일` : `${sp.pay_day}일`) : "-"}</td>
                  <td className={cn(TD, "text-muted-foreground")}>{mask("owner_name", accountName(sp.account_id))}</td>
                  <td className={TD}>{sp.is_active ? <Badge>활성</Badge> : <Badge variant="secondary">비활성</Badge>}</td>
                  <RowActions
                    onEdit={() => setScheduledDialog({ open: true, target: sp })}
                    onDelete={() => void deleteRow("hh_scheduled_payment", sp.id, sp.title)}
                  />
                </tr>
              ))}
            </SimpleTable>
          )}
        </TabsContent>

        {/* ───── 예산 ───── */}
        <TabsContent value="budget" className="pt-4">
          <BudgetTab categories={categories} />
        </TabsContent>

        {/* ───── 문자수집(SMS 자동수집 토큰) ───── */}
        {/* 다른 탭과 동일하게 상단은 액션 버튼 + 표만. 무거운 전송 설정 가이드는 하단 접이식으로. */}
        <TabsContent value="ingest" className="space-y-3 pt-4">
          <div className="flex justify-end">
            <Button onClick={() => void issueToken()}>
              <KeyRound className="h-4 w-4" /> 토큰 발급
            </Button>
          </div>

          {issuedToken && (
            <div className="rounded-2xl border border-amber-400/60 bg-amber-50 p-4 dark:bg-amber-950/30">
              <p className="text-sm font-medium text-amber-700 dark:text-amber-400">새 토큰이 발급되었습니다 — 지금만 표시됩니다. 꼭 복사해두세요.</p>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 break-all rounded bg-background px-3 py-2 font-mono text-sm">{issuedToken}</code>
                <Button size="sm" variant="outline" onClick={() => void copyText(issuedToken)}>
                  <Copy className="h-4 w-4" /> 복사
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setIssuedToken(null)}>닫기</Button>
              </div>
            </div>
          )}

          {tokens.length === 0 ? (
            <EmptyHint text="발급된 토큰이 없습니다. '토큰 발급'으로 폰 연결을 시작하세요." />
          ) : (
            <SimpleTable head={[
              // 열 폭 = 내용별(설계 122). 괄호 안은 실측 필요폭.
              { label: "이름", width: HH_COL.standard },  // 106.7
              { label: "마지막 사용" },                    // 157.2 — 날짜+시각이라 가장 길다(가변)
              { label: "발급일", width: HH_COL.standard }, // 94.3
              { label: "", width: HH_COL.short },          // 폐기 아이콘
            ]}>
              {tokens.map((t) => (
                <tr key={t.id} className={ROW}>
                  <td className={cn(TD, "font-medium")}>{t.label ?? "(이름없음)"}</td>
                  <td className={cn(TD, "text-muted-foreground")}>{t.last_used_at ? new Date(t.last_used_at).toLocaleString("ko-KR") : "미사용"}</td>
                  <td className={cn(TD, "text-muted-foreground")}>{new Date(t.created_at).toLocaleDateString("ko-KR")}</td>
                  <td className={TD}>
                    <div className="flex justify-end">
                      <Button variant="ghost" size="sm" title="폐기" onClick={() => void revokeToken(t.id, t.label)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </SimpleTable>
          )}

          {/* 전송 설정 방법 — 기본 접힘(상단을 가볍게 유지) */}
          <details className="group rounded-2xl border border-border/70 bg-background/40">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium text-foreground">
              <span className="flex items-center gap-2">
                <Smartphone className="h-4 w-4 text-muted-foreground" /> 결제문자 자동수집 설정 방법
              </span>
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="space-y-4 border-t border-border/60 p-4">
              <div className="text-sm text-muted-foreground">
                <p>
                  폰의 <b>문자전달 앱</b>(예: SMS Forwarder)이 결제/입금 문자를 아래 주소로 보내면 수집함에 자동으로 쌓입니다.
                  점검 후 확정하면 거래로 등록됩니다.
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  <li>전송 주소(POST): <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{ingestUrl}</code></li>
                  <li>요청 헤더: <code className="rounded bg-muted px-1.5 py-0.5 text-xs">X-Ingest-Token: 발급받은_토큰</code></li>
                  <li>본문: 문자 원문(JSON <code className="text-xs">{`{"text":"..."}`}</code> / form <code className="text-xs">text=...</code> / 평문 모두 가능)</li>
                </ul>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <MacroSettingCard
                  title="MacroDroid"
                  rows={[
                    { label: "URL", value: ingestUrl },
                    { label: "Method", value: "POST" },
                    { label: "Content-Type", value: "text/plain" },
                    { label: "Header", value: tokenHeader },
                    { label: "Body", value: macroDroidBody },
                  ]}
                />
                <MacroSettingCard
                  title="JSON 전송 앱"
                  rows={[
                    { label: "URL", value: ingestUrl },
                    { label: "Header", value: tokenHeader },
                    { label: "Body", value: jsonBody },
                  ]}
                />
              </div>
            </div>
          </details>
        </TabsContent>
      </Tabs>

      {/* ───── 다이얼로그들 ───── */}
      <PersonDialog
        open={personDialog.open}
        onOpenChange={(open) => setPersonDialog((s) => ({ ...s, open }))}
        target={personDialog.target}
        onSave={async (data) => {
          const ok = personDialog.target
            ? await updateRow("hh_person", personDialog.target.id, data)
            : await insertWithOwner("hh_person", data);
          if (ok) {
            toast.success(personDialog.target ? "수정되었습니다." : "등록되었습니다.");
            await fetchData();
          }
        }}
      />
      <AccountPaymentDialog
        open={accountDialog.open}
        onOpenChange={(open) => setAccountDialog((s) => ({ ...s, open }))}
        target={accountDialog.target}
        persons={persons}
        accounts={accounts}
        onSave={saveAccountPayment}
      />
      <CategoryDialog
        open={categoryDialog.open}
        onOpenChange={(open) => setCategoryDialog((s) => ({ ...s, open }))}
        target={categoryDialog.target}
        defaultKind={categoryDialog.kind}
        onSave={async (data) => {
          const ok = categoryDialog.target
            ? await updateRow("hh_category", categoryDialog.target.id, data)
            : await insertWithOwner("hh_category", data);
          if (ok) {
            toast.success(categoryDialog.target ? "수정되었습니다." : "등록되었습니다.");
            await fetchData();
          }
        }}
      />
      <ScheduledPaymentDialog
        open={scheduledDialog.open}
        onOpenChange={(open) => setScheduledDialog((s) => ({ ...s, open }))}
        target={scheduledDialog.target}
        accounts={accounts}
        methods={methods}
        categories={categories}
        persons={persons}
        onSave={async (data: ScheduledPaymentFormData) => {
          const ok = scheduledDialog.target
            ? await updateRow("hh_scheduled_payment", scheduledDialog.target.id, data)
            : await insertWithOwner("hh_scheduled_payment", data);
          if (ok) {
            toast.success(scheduledDialog.target ? "수정되었습니다." : "등록되었습니다.");
            await fetchData();
          }
        }}
      />
    </PageShell>
  );
}

// ───────────────────────── 보조 컴포넌트 ─────────────────────────

/**
 * 설정 탭 공용 표. 룩(폰트·행높이·열너비)은 공용 게시판 HhBoard와 같은 HH_TABLE 상수를 쓴다.
 * HhBoard 자체를 쓰지 않는 이유: 설정은 행마다 수정·삭제·등록 버튼이 필요한데
 * HhBoard는 행클릭→상세 모델이라 맞지 않는다. 룩만 공유해 어긋남을 막는다.
 * head에 align/className을 주면 열별 정렬·폭도 게시판과 같은 방식으로 지정된다.
 */
/** 열 폭은 width(px) — 반드시 HH_COL 척도에서 고른다. 생략 = 가변 열. (설계 122) */
type SimpleCol = string | { label: string; align?: "left" | "center" | "right"; className?: string; width?: number };

// ★minWidth 는 열 수에 맞춰 준다. table-fixed 에서 min-w 는 곧 '한 열의 최소 px' 이라,
//   기본 640px 에 9열이면 열당 71px(내용 39px)밖에 안 돼 계좌번호·버튼이 옆 칸을 침범한다(768px 실측).
/**
 * 설정 화면 공용 표. 열 폭은 head[].width(px, HH_COL 척도)로만 준다 — className 에 폭을 섞지 않는다.
 * width 를 생략한 열은 가변이고, table-fixed 가 남는 폭을 그 열들끼리 균등 분배한다. (설계 122)
 */
function SimpleTable({ head, children }: { head: SimpleCol[]; children: React.ReactNode }) {
  const alignClass = { left: "text-left", center: "text-center", right: "text-right" } as const;
  const cols = head.map((h) => (typeof h === "string" ? undefined : h.width));
  return (
    <div className={HH_TABLE.shell}>
      <table className={HH_TABLE.table} style={{ width: tableMinWidth(cols) }}>
        <colgroup>
          {colStyles(cols).map((st, i) => <col key={i} style={st} />)}
        </colgroup>
        <thead>
          <tr className={HH_TABLE.headRow}>
            {head.map((h, i) => {
              const c = typeof h === "string" ? { label: h } : h;
              return (
                <th key={i} className={cn(HH_TABLE.th, alignClass[c.align ?? "left"], c.className)}>
                  {c.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** 설정 표의 본문 행 — 공용 게시판과 같은 테두리·호버 */
const ROW = cn(HH_TABLE.row, "hover:bg-muted/40");
/** 설정 표의 본문 셀 — 공용 게시판과 같은 여백(px-4 py-1) */
const TD = HH_TABLE.td;

function RowActions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  return (
    <td className={TD}>
      {/* 행높이를 게시판(py-1)에 맞추려 버튼도 컴팩트하게. 모바일은 터치 타깃 확보로 조금 크게. */}
      <div className="flex justify-end gap-1">
        <Button variant="ghost" size="sm" className="h-8 w-8 md:h-7 md:w-7" title="수정" onClick={onEdit}>
          <Pencil className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="sm" className="h-8 w-8 md:h-7 md:w-7" title="삭제" onClick={onDelete}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </td>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border/70 bg-background/40 p-10 text-center">
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

function MacroSettingCard({ title, rows }: { title: string; rows: Array<{ label: string; value: string }> }) {
  return (
    <div className="rounded-2xl border border-border/70 bg-background/40 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void copyText(rows.map((r) => `${r.label}: ${r.value}`).join("\n"))}
        >
          <Copy className="h-4 w-4" />
          전체 복사
        </Button>
      </div>
      <div className="divide-y divide-border/60">
        {rows.map((row) => (
          <div key={row.label} className="grid gap-1 py-2 md:grid-cols-[96px_1fr_auto] md:items-center">
            <span className="text-xs font-medium text-muted-foreground">{row.label}</span>
            <code className="break-all rounded bg-muted px-2 py-1 font-mono text-xs text-foreground">{row.value}</code>
            <Button size="icon" variant="ghost" title={`${row.label} 복사`} onClick={() => void copyText(row.value)}>
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function CategoryBlock({
  title,
  cats,
  onAdd,
  onEdit,
  onDelete,
}: {
  title: string;
  cats: HhCategory[];
  onAdd: () => void;
  onEdit: (c: HhCategory) => void;
  onDelete: (c: HhCategory) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <Button size="sm" variant="outline" onClick={onAdd}>
          <Plus className="h-4 w-4" /> 추가
        </Button>
      </div>
      {cats.length === 0 ? (
        <EmptyHint text="카테고리가 없습니다. '기본값 생성' 또는 '추가'로 만드세요." />
      ) : (
        <div className="flex flex-wrap gap-2">
          {cats.map((c) => (
            <div
              key={c.id}
              className="group flex items-center gap-2 rounded-full border border-border/70 bg-card/70 py-1.5 pl-3.5 pr-2 text-sm"
            >
              <span className={c.is_active ? "" : "text-muted-foreground line-through"}>{c.name}</span>
              {c.is_fixed ? <Badge variant="secondary" className="text-[10px]">고정</Badge> : null}
              <button
                type="button"
                onClick={() => onEdit(c)}
                className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                title="수정"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onDelete(c)}
                className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-rose-600"
                title="삭제"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
