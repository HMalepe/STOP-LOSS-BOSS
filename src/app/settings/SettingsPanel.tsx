"use client";
import { LogOut, OctagonPause, Play, ShieldOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type ApiError, type KillSwitch, type Result } from "@/ui/api";
import { Panel } from "@/ui/AppShell";
import { Button } from "@/ui/Button";
import { Metric } from "@/ui/Metric";
import { ModeBadge, type Mode } from "@/ui/ModeBadge";
import { OtpInput } from "@/ui/OtpInput";
import { ErrorState } from "@/ui/States";
import { StatusBadge } from "@/ui/StatusBadge";
import { useToast } from "@/ui/Toast";

export interface Limits {
  readonly orders: number;
  readonly lots: number;
  readonly riskPct: number;
  readonly perBatch: number;
  readonly spreadK: number;
}

/** Runs a sensitive action; if the server wants a fresh code, asks for one inline and retries once. */
function useReauth() {
  const [asking, setAsking] = useState<null | { run: () => Promise<Result<unknown>>; why: string }>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const attempt = async (run: () => Promise<Result<unknown>>, why: string): Promise<Result<unknown>> => {
    const r = await run();
    if (!r.ok && r.code === "REAUTH_REQUIRED") setAsking({ run, why });
    return r;
  };
  const submit = async (c: string): Promise<Result<unknown> | null> => {
    if (asking === null) return null;
    setBusy(true);
    setError(null);
    const r = await api.reauth(c);
    if (!r.ok) {
      setBusy(false);
      setCode("");
      setError(r.message);
      return null;
    }
    const done = await asking.run();
    setBusy(false);
    setCode("");
    setAsking(null);
    return done;
  };
  return {
    asking,
    code,
    setCode,
    error,
    busy,
    attempt,
    submit,
    cancel: () => {
      setAsking(null);
      setError(null);
      setCode("");
    },
  };
}

export function SettingsPanel({ mode, limits }: { readonly mode: Mode; readonly limits: Limits }) {
  const router = useRouter();
  const toast = useToast();
  const [ks, setKs] = useState<KillSwitch | null>(null);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const re = useReauth();

  useEffect(() => {
    const t = setTimeout(() => {
      void api.killSwitch().then((r) => {
        if (r.ok) setKs(r.data);
        else setProblem(r);
      });
    }, 0);
    return () => {
      clearTimeout(t);
    };
  }, []);

  const settle = (r: Result<unknown> | null, ok: () => void) => {
    if (r === null) return;
    if (r.ok) ok();
    else if (r.code !== "REAUTH_REQUIRED") setProblem(r);
  };

  const halt = async (halted: boolean) => {
    setBusy(true);
    setProblem(null);
    const r = await re.attempt(
      () => api.setKillSwitch(halted),
      "Turning trading back on needs a fresh code.",
    );
    setBusy(false);
    settle(r, () => {
      if (r.ok) setKs(r.data as KillSwitch);
      toast(
        halted
          ? "Trading halted. Running batches were stopped; Close All Now still works."
          : "Trading resumed.",
        "ok",
      );
    });
  };
  const everywhere = async () => {
    setProblem(null);
    const r = await re.attempt(() => api.revokeAll(), "Signing out every device needs a fresh code.");
    settle(r, () => {
      router.replace("/login");
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Kill switch"
        meta={ks === null ? "loading" : ks.halted ? "trading is halted" : "trading is on"}
        actions={
          ks === null ? null : ks.halted ? (
            <StatusBadge tone="down">Halted</StatusBadge>
          ) : (
            <StatusBadge tone="up">On</StatusBadge>
          )
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            Halting blocks every new order and change at once and stops batches already running. Close All Now
            always still works. Turning trading back on needs a fresh code.
          </p>
          {ks?.byEnv === true ? (
            <p className="text-sm text-warn">
              Halted by the server config (TRADING_HALTED). It can only be lifted there.
            </p>
          ) : null}
          {ks === null ? (
            <span className="skeleton h-12 w-full" />
          ) : ks.byDb ? (
            <Button
              variant="primary"
              block
              loading={busy}
              icon={<Play aria-hidden className="size-4" />}
              onClick={() => void halt(false)}
            >
              Resume trading
            </Button>
          ) : (
            <Button
              variant="danger"
              block
              loading={busy}
              disabled={ks.byEnv}
              icon={<OctagonPause aria-hidden className="size-4" />}
              onClick={() => void halt(true)}
            >
              Halt trading now
            </Button>
          )}
        </div>
      </Panel>

      {re.asking === null ? null : (
        <Panel title="Fresh code needed" meta={re.asking.why}>
          <div className="flex flex-col gap-3">
            <OtpInput
              value={re.code}
              onChange={re.setCode}
              disabled={re.busy}
              invalid={re.error !== null}
              onComplete={(c) => {
                void re.submit(c).then((r) => {
                  settle(r, () => {
                    if (
                      r?.ok === true &&
                      r.data !== null &&
                      typeof r.data === "object" &&
                      "halted" in r.data
                    ) {
                      setKs(r.data as KillSwitch);
                      toast("Trading resumed.", "ok");
                    } else router.replace("/login");
                  });
                });
              }}
            />
            {re.error === null ? null : (
              <p role="alert" className="text-sm text-down">
                {re.error}
              </p>
            )}
            <Button variant="ghost" block onClick={re.cancel}>
              Cancel
            </Button>
          </div>
        </Panel>
      )}

      <Panel title="Mode and limits" meta="server config, read-only">
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <ModeBadge mode={mode} />
            <span className="text-sm text-muted">
              {mode === "live"
                ? "Real money. Every confirm is press-and-hold."
                : mode === "demo"
                  ? "Real broker, demo money."
                  : "Simulated broker. Nothing leaves this app."}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3">
            <Metric
              label="Orders / action"
              value={String(limits.orders)}
              hint="Most new entries one action may open."
            />
            <Metric
              label="Lots / action"
              value={String(limits.lots)}
              hint="Most total lots one action may open."
            />
            <Metric
              label="Risk / action"
              value={String(limits.riskPct)}
              unit="%"
              hint="Most account equity at risk to the stops, per action."
            />
            <Metric
              label="Positions / batch"
              value={limits.perBatch.toLocaleString("en-US")}
              hint="Most positions one SL/TP or close-at change may touch. Close All Now has no cap."
            />
            <Metric
              label="Spread guard"
              value={`${String(limits.spreadK)}×`}
              hint="A batch is refused while the spread is this many times wider than normal."
            />
          </dl>
        </div>
      </Panel>

      <Panel title="Sign-in">
        <div className="grid gap-2 sm:grid-cols-2">
          <Button
            icon={<LogOut aria-hidden className="size-4" />}
            onClick={() =>
              void api.logout().then(() => {
                router.replace("/login");
              })
            }
          >
            Sign out
          </Button>
          <Button
            variant="danger"
            icon={<ShieldOff aria-hidden className="size-4" />}
            onClick={() => void everywhere()}
          >
            Sign out everywhere
          </Button>
        </div>
      </Panel>

      {problem === null ? null : <ErrorState title={problem.message} />}
    </div>
  );
}
