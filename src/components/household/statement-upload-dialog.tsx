"use client";
import { toast } from "sonner";

import { useState } from "react";
import { FileUp, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  autoDetectMapping,
  dedupHash,
  mapStatementRows,
  readStatementFile,
  type ColumnMapping,
  type ParsedStatementRow,
} from "@/lib/household/statement";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base md:text-sm shadow-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

export type NewInboxRow = {
  guessed_date: string;
  guessed_amount: number;
  guessed_merchant: string;
  guessed_type: "income" | "expense";
  guessed_category_id: string | null;
  source_adapter: string;
  raw_text: string;
  dedup_hash: string;
  confidence: number;
};

export function StatementUploadDialog({
  open,
  onOpenChange,
  existingHashes,
  guessCategory,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingHashes: Set<string>;
  guessCategory: (merchant: string) => string | null;
  onSave: (rows: NewInboxRow[]) => Promise<void>;
}) {
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setFileName(""); setHeaders([]); setRows([]); setMapping(null); setSkip(new Set());
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const { headers: h, rows: r } = await readStatementFile(file);
      setFileName(file.name);
      setHeaders(h);
      setRows(r);
      setMapping(autoDetectMapping(h));
      setSkip(new Set());
    } catch {
      toast.error("파일을 읽지 못했습니다. CSV 또는 엑셀(.xlsx) 파일인지 확인해주세요.");
    } finally {
      setBusy(false);
    }
  };

  const parsed: ParsedStatementRow[] = mapping ? mapStatementRows(rows, mapping).parsed : [];
  const skippedCount = mapping ? mapStatementRows(rows, mapping).skipped : 0;
  const dupOf = (p: ParsedStatementRow) => existingHashes.has(dedupHash(p));

  const close = () => { reset(); onOpenChange(false); };

  const submit = async () => {
    if (!mapping) return;
    const toAdd: NewInboxRow[] = parsed
      .map((p, i) => ({ p, i }))
      .filter(({ p, i }) => !skip.has(i) && !dupOf(p))
      .map(({ p }) => ({
        guessed_date: p.date,
        guessed_amount: p.amount,
        guessed_merchant: p.merchant,
        guessed_type: p.type,
        guessed_category_id: p.type === "expense" ? guessCategory(p.merchant) : null,
        source_adapter: mapping.typeCol != null ? "file_mapped_typed" : "file_mapped",
        raw_text: p.raw,
        dedup_hash: dedupHash(p),
        confidence: 70,
      }));
    if (toAdd.length === 0) {
      toast.error("추가할 행이 없습니다. (중복이거나 모두 제외됨)");
      return;
    }
    setSaving(true);
    try {
      await onSave(toAdd);
      close();
    } finally {
      setSaving(false);
    }
  };

  const col = (key: keyof ColumnMapping, label: string, allowNone = false) => (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <select
        className={selectClass}
        value={mapping ? String(mapping[key]) : ""}
        onChange={(e) => setMapping((m) => (m ? { ...m, [key]: e.target.value === "" ? null : Number(e.target.value) } : m))}
      >
        {allowNone ? <option value="">없음</option> : null}
        {headers.map((h, i) => (<option key={i} value={i}>{h || `(${i + 1}열)`}</option>))}
      </select>
    </div>
  );

  const newCount = parsed.filter((p, i) => !skip.has(i) && !dupOf(p)).length;

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>명세서 업로드</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* 1. 파일 선택 */}
          <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 p-4">
            <label className="flex cursor-pointer items-center gap-3 text-sm">
              <span className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 font-medium">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
                파일 선택
              </span>
              <span className="text-muted-foreground">{fileName || "카드사·은행 명세서 (.csv / .xlsx)"}</span>
              <input type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
            </label>
            <p className="mt-2 text-xs text-muted-foreground">파일 자체는 업로드되지 않고 브라우저에서 분석됩니다. 수집함으로 가져온 행의 원문은 내 계정 DB에 저장되며 30일 뒤 자동 삭제됩니다.</p>
          </div>

          {/* 2. 컬럼 매핑 */}
          {headers.length > 0 && mapping ? (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                {col("dateCol", "날짜 열")}
                {col("amountCol", "금액 열")}
                {col("merchantCol", "가맹점 열")}
                {col("typeCol", "입출금 구분 열", true)}
                <div className="space-y-1.5">
                  <Label className="text-xs">기본 유형</Label>
                  <select className={selectClass} value={mapping.defaultType} onChange={(e) => setMapping({ ...mapping, defaultType: e.target.value as "income" | "expense" })}>
                    <option value="expense">지출</option>
                    <option value="income">수입</option>
                  </select>
                </div>
              </div>

              {/* 3. 미리보기 */}
              <div className="max-h-72 overflow-auto rounded-lg border border-border/70">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted/60 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">제외</th>
                      <th className="px-3 py-2 font-medium">날짜</th>
                      <th className="px-3 py-2 text-right font-medium">금액</th>
                      <th className="px-3 py-2 font-medium">가맹점</th>
                      <th className="px-3 py-2 font-medium">유형</th>
                      <th className="px-3 py-2 font-medium">상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.map((p, i) => {
                      const dup = dupOf(p);
                      return (
                        <tr key={i} className={`border-b border-border/40 last:border-0 ${dup ? "opacity-50" : ""}`}>
                          <td className="px-3 py-1.5">
                            <input type="checkbox" className="h-4 w-4" checked={skip.has(i) || dup} disabled={dup}
                              onChange={(e) => setSkip((s) => { const n = new Set(s); if (e.target.checked) n.add(i); else n.delete(i); return n; })} />
                          </td>
                          <td className="whitespace-nowrap px-3 py-1.5">{p.date}</td>
                          <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">{p.amount.toLocaleString("ko-KR")}원</td>
                          <td className="px-3 py-1.5">{p.merchant || "-"}</td>
                          <td className="px-3 py-1.5">{p.type === "income" ? "수입" : "지출"}</td>
                          <td className="px-3 py-1.5 text-xs">{dup ? <span className="text-amber-600">중복</span> : <span className="text-emerald-600">신규</span>}</td>
                        </tr>
                      );
                    })}
                    {parsed.length === 0 ? (
                      <tr><td colSpan={6} className="px-3 py-6 text-center text-sm text-muted-foreground">인식된 거래가 없습니다. 열 매핑을 확인해주세요.</td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground">
                신규 <b className="text-foreground">{newCount}</b>건 · 중복 {parsed.filter(dupOf).length}건 · 제외/오류 {skippedCount}건
              </p>
            </>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>취소</Button>
          <Button type="button" onClick={() => void submit()} disabled={saving || newCount === 0}>
            {saving ? "추가 중..." : `수집함에 ${newCount}건 추가`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
