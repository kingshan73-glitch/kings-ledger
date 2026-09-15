// 거래 전량 로드 헬퍼 (설계 90 §4)
//
// Supabase 는 한 번에 1,000행만 준다. 이 한계를 모르고 .select() 를 그냥 쓰면
// **에러 없이 조용히 잘린 데이터**로 계산해 그래프·합계가 틀린 숫자를 그린다.
// 설계 90 을 조사하다 실제로 당했다(올해 거래가 정확히 1,000건 나와 "5월 이후 거래 없음"으로 오판).
// 기간 거래를 다루는 화면은 반드시 이 함수를 쓴다.
//
// 원래 통계 페이지 안에 있던 것을 요약 탭과 공용으로 쓰려고 옮겼다. (설계 61 R4 → 90 §4)
import type { createClient } from "@/lib/supabase/client";
import type { HhTransaction, HhTransactionType } from "@/lib/household/types";

type SB = ReturnType<typeof createClient>;

const PAGE = 1000;

type FetchTxnsOpts = {
  /** 거래 종류 서버 필터. 목록 화면처럼 한 종류만 필요할 때 쓴다(전량 받아 거르지 않는다). */
  type?: HhTransactionType;
};

/**
 * [from, end) 기간의 거래를 전량 로드한다. 실패하면 null.
 * from/end 를 비우면 그 방향은 무제한(기간 미지정 조회) — 그래도 페이징은 그대로 돈다.
 */
export async function fetchTxnsPaged(
  supabase: SB,
  from?: string | null,
  end?: string | null,
  opts?: FetchTxnsOpts
): Promise<HhTransaction[] | null> {
  const out: HhTransaction[] = [];
  for (let page = 0; ; page++) {
    let q = supabase.from("hh_transaction").select("*");
    if (opts?.type) q = q.eq("type", opts.type);
    if (from) q = q.gte("txn_date", from);
    if (end) q = q.lt("txn_date", end);
    const { data, error } = await q
      .order("txn_date")
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) {
      console.error("거래 조회 실패:", error);
      return null;
    }
    out.push(...((data ?? []) as HhTransaction[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}
