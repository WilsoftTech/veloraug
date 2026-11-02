import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "ghost";

const base =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-default px-6 text-label-lg transition duration-150 disabled:pointer-events-none disabled:opacity-50";

const variants: Record<ButtonVariant, string> = {
  // Solid cinema red, with a subtle halo on hover.
  primary: "bg-accent text-accent-foreground hover:bg-accent-hover hover:shadow-glow active:bg-accent-hover",
  secondary:
    "border border-border bg-surface text-foreground hover:border-highlight/40 hover:bg-surface-elevated active:bg-surface-elevated",
  ghost: "text-muted hover:text-foreground active:text-foreground",
};

/** Class names shared by `<Link>` and `<button>` so both look identical. */
export function buttonClass(variant: ButtonVariant = "primary", className?: string) {
  return cn(base, variants[variant], className);
}
