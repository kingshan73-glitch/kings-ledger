"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react";
import {
  format,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  addDays,
  addMonths,
  subMonths,
  isSameMonth,
  isSameDay,
} from "date-fns";
import { ko } from "date-fns/locale";

interface DateInputProps {
  value: string; // YYYY-MM-DD or ""
  onChange: (value: string) => void;
  placeholder?: string;
  id?: string;
  className?: string;
}

function formatDigits(digits: string): string {
  if (digits.length <= 4) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 4)}-${digits.slice(4)}`;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
}

export function DateInput({
  value,
  onChange,
  placeholder,
  id,
  className,
}: DateInputProps) {
  const [display, setDisplay] = useState("");
  const [showCalendar, setShowCalendar] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(new Date());
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync external value → display
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- controlled prop의 외부 초기화/폼 재설정을 표시값에 반영
    setDisplay(value || "");
  }, [value]);

  // Close calendar on outside click
  useEffect(() => {
    if (!showCalendar) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setShowCalendar(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showCalendar]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const rawValue = input.value;
    const cursorPos = input.selectionStart || 0;

    // Count digits before cursor in raw input
    let digitsBeforeCursor = 0;
    for (let i = 0; i < cursorPos; i++) {
      if (/\d/.test(rawValue[i])) digitsBeforeCursor++;
    }

    const digits = rawValue.replace(/\D/g, "").slice(0, 8);
    const formatted = formatDigits(digits);
    setDisplay(formatted);

    // Calculate new cursor position based on digit count
    let newCursor = 0;
    let seen = 0;
    for (let i = 0; i < formatted.length; i++) {
      if (seen >= digitsBeforeCursor) break;
      newCursor = i + 1;
      if (/\d/.test(formatted[i])) seen++;
    }

    requestAnimationFrame(() => {
      input.setSelectionRange(newCursor, newCursor);
    });

    if (digits.length === 8) {
      const m = parseInt(digits.slice(4, 6));
      const d = parseInt(digits.slice(6, 8));
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        onChange(formatted);
      }
    } else {
      onChange("");
    }
  };

  const handleCalendarSelect = (date: Date) => {
    const formatted = format(date, "yyyy-MM-dd");
    setDisplay(formatted);
    onChange(formatted);
    setShowCalendar(false);
    inputRef.current?.focus();
  };

  const toggleCalendar = () => {
    if (!showCalendar && value) {
      const [y, m, d] = value.split("-").map(Number);
      if (y && m && d) setCalendarMonth(new Date(y, m - 1, d));
    }
    setShowCalendar((prev) => !prev);
  };

  // Build calendar grid
  const selectedDate = value
    ? (() => {
        const [y, m, d] = value.split("-").map(Number);
        return y && m && d ? new Date(y, m - 1, d) : null;
      })()
    : null;
  const today = new Date();

  const monthStart = startOfMonth(calendarMonth);
  const monthEnd = endOfMonth(calendarMonth);
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 0 });
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 0 });

  const days: Date[] = [];
  let cursor = gridStart;
  while (cursor <= gridEnd) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }

  const weeks: Date[][] = [];
  for (let i = 0; i < days.length; i += 7) {
    weeks.push(days.slice(i, i + 7));
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Input
          ref={inputRef}
          id={id}
          type="text"
          inputMode="numeric"
          value={display}
          onChange={handleChange}
          placeholder={placeholder || "YYYYMMDD"}
          className={className}
        />
        <button
          type="button"
          onClick={toggleCalendar}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
        >
          <CalendarIcon className="h-4 w-4" />
        </button>
      </div>

      {showCalendar && (
        <div className="absolute top-full left-0 z-50 mt-1 w-[280px] rounded-md border bg-popover p-3 shadow-md">
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              onClick={() => setCalendarMonth(subMonths(calendarMonth, 1))}
              className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-accent"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-medium">
              {format(calendarMonth, "yyyy년 M월", { locale: ko })}
            </span>
            <button
              type="button"
              onClick={() => setCalendarMonth(addMonths(calendarMonth, 1))}
              className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-accent"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-7 text-center">
            {["일", "월", "화", "수", "목", "금", "토"].map((d) => (
              <div
                key={d}
                className="py-1 text-xs text-muted-foreground font-medium"
              >
                {d}
              </div>
            ))}
            {weeks.map((week, wi) =>
              week.map((d, di) => {
                const isCurrentMonth = isSameMonth(d, calendarMonth);
                const isSelected = selectedDate && isSameDay(d, selectedDate);
                const isToday = isSameDay(d, today);
                return (
                  <button
                    key={`${wi}-${di}`}
                    type="button"
                    onClick={() => handleCalendarSelect(d)}
                    className={`h-8 w-8 mx-auto rounded-md text-xs transition-colors
                      ${!isCurrentMonth ? "text-muted-foreground/40" : ""}
                      ${isSelected ? "bg-primary text-primary-foreground" : ""}
                      ${isToday && !isSelected ? "bg-accent font-bold" : ""}
                      ${isCurrentMonth && !isSelected ? "hover:bg-accent" : ""}
                    `}
                  >
                    {format(d, "d")}
                  </button>
                );
              })
            )}
          </div>
          <div className="mt-2 flex justify-between border-t pt-2">
            <button
              type="button"
              onClick={() => handleCalendarSelect(new Date())}
              className="text-xs text-primary hover:underline"
            >
              오늘
            </button>
            <button
              type="button"
              onClick={() => {
                setDisplay("");
                onChange("");
                setShowCalendar(false);
              }}
              className="text-xs text-muted-foreground hover:underline"
            >
              지우기
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
