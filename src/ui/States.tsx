import { CircleAlert, Inbox, WifiOff } from "lucide-react";
import type { ReactNode } from "react";

/** Designed empty / error / offline states: say what happened and what to do next, in plain words. */
export function EmptyState({
  title,
  body,
  action,
  icon,
}: {
  readonly title: string;
  readonly body?: string;
  readonly action?: ReactNode;
  readonly icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <span className="grid size-10 place-items-center rounded-full border border-line bg-raised text-muted">
        {icon ?? <Inbox aria-hidden className="size-5" strokeWidth={1.5} />}
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-[0.9375rem] font-medium text-text">{title}</p>
        {body === undefined ? null : <p className="max-w-xs text-sm text-muted">{body}</p>}
      </div>
      {action}
    </div>
  );
}

export function ErrorState({
  title,
  body,
  action,
}: {
  readonly title: string;
  readonly body?: string;
  readonly action?: ReactNode;
}) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-card border border-down/40 bg-down/8 p-4">
      <CircleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-down" strokeWidth={1.75} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div>
          <p className="text-sm font-medium text-text">{title}</p>
          {body === undefined ? null : <p className="text-sm text-subtle">{body}</p>}
        </div>
        {action}
      </div>
    </div>
  );
}

export function OfflineBanner() {
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-warn/30 bg-warn/8 px-gutter py-2 text-sm text-warn"
    >
      <WifiOff aria-hidden className="size-4" strokeWidth={1.75} />
      You're offline. Prices and actions resume when you reconnect.
    </div>
  );
}
