"use client";

import { useState, useCallback } from "react";
import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type SortDirection = "asc" | "desc" | null;

export interface SortState<T extends string = string> {
  key: T | null;
  direction: SortDirection;
}

export function useSortState<T extends string = string>(
  defaultKey?: T,
  defaultDirection: SortDirection = "asc"
) {
  const [sort, setSort] = useState<SortState<T>>({
    key: defaultKey ?? null,
    direction: defaultKey ? defaultDirection : null,
  });

  const toggle = useCallback((key: string) => {
    setSort((prev) => {
      if (prev.key !== key) return { key: key as T, direction: "asc" };
      if (prev.direction === "asc") return { key: key as T, direction: "desc" };
      return { key: null, direction: null };
    });
  }, []);

  return { sort, toggle };
}

export function sortData<T>(
  data: T[],
  sort: SortState,
  getter: (item: T, key: string) => string | number | null | undefined
): T[] {
  if (!sort.key || !sort.direction) return data;
  const key = sort.key;
  const dir = sort.direction === "asc" ? 1 : -1;
  return [...data].sort((a, b) => {
    const av = getter(a, key);
    const bv = getter(b, key);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number")
      return (av - bv) * dir;
    return String(av).localeCompare(String(bv), "ko") * dir;
  });
}

interface SortableTableHeadProps {
  sortKey: string;
  currentSort: SortState;
  onSort: (key: string) => void;
  children: React.ReactNode;
  className?: string;
}

export function SortableTableHead({
  sortKey,
  currentSort,
  onSort,
  children,
  className,
}: SortableTableHeadProps) {
  const isActive = currentSort.key === sortKey;

  return (
    <TableHead
      className={cn("cursor-pointer select-none hover:bg-muted/50", className)}
      onClick={() => onSort(sortKey)}
    >
      <div className="flex items-center gap-1">
        {children}
        <span className="inline-flex flex-col text-[10px] leading-none">
          <span className={isActive && currentSort.direction === "asc" ? "text-foreground" : "text-muted-foreground/40"}>
            ▲
          </span>
          <span className={isActive && currentSort.direction === "desc" ? "text-foreground" : "text-muted-foreground/40"}>
            ▼
          </span>
        </span>
      </div>
    </TableHead>
  );
}
