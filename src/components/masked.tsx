"use client";

import * as React from "react";

import { useMasking } from "@/components/masking-provider";
import type { MaskCategory } from "@/lib/masking";

type MaskedProps = {
  category: MaskCategory;
  children: React.ReactNode;
};

export function Masked({ category, children }: MaskedProps) {
  const { mask } = useMasking();
  if (typeof children === "string" || typeof children === "number") {
    return <>{mask(category, children)}</>;
  }
  return <>{children}</>;
}
