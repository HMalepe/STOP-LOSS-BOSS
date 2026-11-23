"use client";
import { History, LayoutGrid, Settings2 } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "./cx";

export const NAV: readonly {
  readonly href: Route;
  readonly label: string;
  readonly icon: typeof LayoutGrid;
}[] = [
  { href: "/", label: "Desk", icon: LayoutGrid },
  { href: "/history", label: "History", icon: History },
  { href: "/settings", label: "Settings", icon: Settings2 },
];

const isActive = (path: string, href: string) => (href === "/" ? path === "/" : path.startsWith(href));

/** Phone: a bottom tab bar in the thumb zone. */
export function BottomNav() {
  const path = usePathname();
  return (
    <nav
      aria-label="Main"
      className="grid grid-cols-3 border-t border-line bg-bg/92 backdrop-blur-md lg:hidden"
    >
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = isActive(path, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "flex min-h-tap flex-col items-center justify-center gap-0.5 pt-1.5 text-2xs font-medium transition-colors",
              active ? "text-text" : "text-muted hover:text-subtle",
            )}
          >
            <Icon
              aria-hidden
              className={cx("size-5", active && "text-accent")}
              strokeWidth={active ? 2 : 1.6}
            />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Desktop: a compact left rail. */
export function SideNav() {
  const path = usePathname();
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = isActive(path, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors",
              active ? "bg-raised text-text" : "text-muted hover:bg-raised/60 hover:text-subtle",
            )}
          >
            {active ? (
              <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent" />
            ) : null}
            <Icon aria-hidden className="size-4" strokeWidth={active ? 2 : 1.6} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
