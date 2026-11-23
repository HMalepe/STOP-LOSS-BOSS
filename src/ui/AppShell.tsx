import type { ReactNode } from "react";
import { Wordmark } from "./Logo";
import { ModeBadge, type Mode } from "./ModeBadge";
import { BottomNav, SideNav } from "./NavLinks";

/**
 * The frame every screen sits in.
 * Phone (default): sticky top bar (mark, mode, context) · content · fixed bottom stack (primary action slot + tab bar),
 * everything important in the thumb zone. Desktop (lg+): a left rail replaces the tab bar; content keeps a readable width.
 */
export function AppShell({
  mode,
  context,
  status,
  bottom,
  children,
}: {
  readonly mode: Mode;
  /** Top-bar centre: symbol picker + live quote on the desk. */
  readonly context?: ReactNode;
  /** Top-bar right: connection / freshness. */
  readonly status?: ReactNode;
  /** Fixed above the tab bar on phones (e.g. CLOSE ALL NOW). */
  readonly bottom?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col gap-6 border-r border-line bg-ink/60 px-3 py-4 lg:flex">
        <div className="px-1.5">
          <Wordmark />
        </div>
        <SideNav />
        <div className="mt-auto flex flex-col items-start gap-2 px-1.5">
          <ModeBadge mode={mode} />
          <p className="text-2xs text-faint">Every action is previewed before anything is sent.</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-line bg-bg/88 pt-[env(safe-area-inset-top)] backdrop-blur-md">
          <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-gutter">
            <span className="lg:hidden">
              <Wordmark compact />
            </span>
            <div className="min-w-0 flex-1">{context}</div>
            {status}
            <span className="lg:hidden">
              <ModeBadge mode={mode} />
            </span>
          </div>
        </header>

        <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 px-gutter pt-4 pb-40 lg:pb-28">
          {children}
        </main>

        <div className="fixed inset-x-0 bottom-0 z-30 pb-[env(safe-area-inset-bottom)] lg:left-56">
          {bottom === undefined ? null : (
            <div className="border-t border-line bg-bg/95 backdrop-blur-md">
              <div className="mx-auto w-full max-w-5xl px-gutter py-3">{bottom}</div>
            </div>
          )}
          <BottomNav />
        </div>
      </div>
    </div>
  );
}

/** Page title + optional supporting line and actions. Large type is reserved for this and headline numbers. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-text">{title}</h1>
        {subtitle === undefined ? null : <p className="text-sm text-muted">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

/** A titled hairline panel. Every chart/table sits in one, with its context line. */
export function Panel({
  title,
  meta,
  actions,
  children,
  flush = false,
}: {
  readonly title?: string;
  readonly meta?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly flush?: boolean;
}) {
  return (
    <section className="panel overflow-hidden">
      {title === undefined ? null : (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="truncate text-sm font-medium text-text">{title}</h2>
            {meta === undefined ? null : <span className="truncate text-xs text-muted">{meta}</span>}
          </div>
          {actions}
        </header>
      )}
      <div className={flush ? "" : "p-4"}>{children}</div>
    </section>
  );
}
