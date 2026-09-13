import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

const VARIANT_CLASSES = {
  neutral: "bg-slate-100 text-slate-700 ring-slate-500/10",
  success: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  warning: "bg-amber-50 text-amber-800 ring-amber-600/20",
  danger: "bg-rose-50 text-rose-700 ring-rose-600/20",
  info: "bg-sky-50 text-sky-700 ring-sky-600/20",
} as const;

export type BadgeVariant = keyof typeof VARIANT_CLASSES;

export function Badge({
  variant = "neutral",
  children,
}: {
  variant?: BadgeVariant;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        VARIANT_CLASSES[variant],
      )}
    >
      {children}
    </span>
  );
}
