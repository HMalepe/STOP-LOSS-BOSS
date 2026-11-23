import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "panic";

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-accent-ink hover:bg-accent-strong active:brightness-95 disabled:bg-raised disabled:text-faint",
  secondary:
    "border border-line-strong bg-raised text-text hover:border-faint hover:bg-overlay disabled:text-faint",
  ghost: "text-subtle hover:bg-raised hover:text-text disabled:text-faint",
  /** Close All Now only: solid, unmistakable, the one loud thing on the screen. */
  panic:
    "bg-danger font-semibold tracking-wide text-ink hover:brightness-110 disabled:bg-raised disabled:text-faint",
  danger:
    "border border-danger/50 bg-danger/12 text-danger hover:bg-danger/20 disabled:border-line disabled:bg-raised disabled:text-faint",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  /** "md" is the 48 px tap target (default). "sm" only for dense, non-critical controls. */
  readonly size?: "md" | "sm";
  readonly loading?: boolean;
  readonly icon?: ReactNode;
  readonly block?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  block = false,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={cx(
        "inline-flex select-none items-center justify-center gap-2 rounded-md font-medium",
        "transition-[background-color,border-color,color,transform] duration-150 ease-out-quint active:scale-[0.985]",
        "disabled:cursor-not-allowed disabled:active:scale-100",
        size === "md" ? "min-h-tap px-4 text-[0.9375rem]" : "h-9 px-3 text-sm",
        block && "w-full",
        VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
}

export function Spinner({ className }: { readonly className?: string }) {
  return (
    <span
      aria-hidden
      className={cx(
        "inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent",
        className,
      )}
    />
  );
}
