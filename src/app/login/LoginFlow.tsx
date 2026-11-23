"use client";
import { ArrowLeft, KeyRound, LockKeyhole } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { Button } from "@/ui/Button";
import { Logo } from "@/ui/Logo";
import { ModeBadge, type Mode } from "@/ui/ModeBadge";
import { OtpInput } from "@/ui/OtpInput";
import { ErrorState } from "@/ui/States";
import { useNow } from "@/ui/useNow";

type Step = "password" | "code" | "recovery";
interface Problem {
  readonly text: string;
  readonly until?: number;
}

async function post(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; message: string; retryAfter?: number }> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true, status: res.status, message: "" };
    const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    const retry = Number(res.headers.get("retry-after"));
    return {
      ok: false,
      status: res.status,
      message: data?.error?.message ?? "Something went wrong. Try again.",
      ...(Number.isFinite(retry) && retry > 0 ? { retryAfter: retry } : {}),
    };
  } catch {
    return { ok: false, status: 0, message: "Can't reach the server. Check your connection." };
  }
}

/** Password → 6-digit code (or a recovery code) → the desk. One screen, one task at a time. */
export function LoginFlow({ mode }: { readonly mode: Mode }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("password");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const now = useNow(500);
  const pwRef = useRef<HTMLInputElement>(null);
  const waitS = problem?.until === undefined ? 0 : Math.max(0, Math.ceil((problem.until - now) / 1000));

  useEffect(() => {
    if (step === "password") pwRef.current?.focus();
  }, [step]);

  const fail = (r: { message: string; retryAfter?: number }) => {
    setProblem({
      text: r.message,
      ...(r.retryAfter === undefined ? {} : { until: Date.now() + r.retryAfter * 1000 }),
    });
  };

  const submitPassword = async (e: SyntheticEvent) => {
    e.preventDefault();
    if (password === "" || busy) return;
    setBusy(true);
    setProblem(null);
    const r = await post("/api/auth/login", { password });
    setBusy(false);
    if (!r.ok) {
      fail(r);
      return;
    }
    setPassword("");
    setStep("code");
  };

  const submitCode = async (value: string) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const r = await post("/api/auth/totp", { code: value });
    if (r.ok) {
      router.replace("/");
      router.refresh();
      return;
    }
    setBusy(false);
    setCode("");
    setRecovery("");
    // The pending login is gone (expired or too many tries): back to the password, with the reason.
    if (r.message.startsWith("Login expired") || r.message.startsWith("Enter your password")) {
      setStep("password");
    }
    fail(r);
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-14 items-center justify-between px-gutter pt-[env(safe-area-inset-top)]">
        <span className="flex items-center gap-2 text-text">
          <Logo className="size-6" />
          <span className="text-[0.9375rem] font-semibold tracking-tight">
            Order<span className="text-muted">Desk</span>
          </span>
        </span>
        <ModeBadge mode={mode} />
      </header>

      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8 px-gutter pb-16">
        <div className="flex flex-col gap-3">
          <span className="grid size-11 place-items-center rounded-card border border-line bg-surface text-accent">
            {step === "password" ? (
              <LockKeyhole aria-hidden className="size-5" strokeWidth={1.6} />
            ) : (
              <KeyRound aria-hidden className="size-5" strokeWidth={1.6} />
            )}
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-text">
            {step === "password" ? "Sign in" : step === "code" ? "Enter your code" : "Use a recovery code"}
          </h1>
          <p className="text-sm text-muted">
            {step === "password"
              ? "This desk can move real money. Password first, then your authenticator."
              : step === "code"
                ? "Open your authenticator app and type the 6-digit code for Order Desk."
                : "Each recovery code works once. You'll see how many are left after signing in."}
          </p>
        </div>

        {step === "password" ? (
          <form onSubmit={(e) => void submitPassword(e)} className="flex flex-col gap-4">
            <label className="flex flex-col gap-2">
              <span className="eyebrow">Password</span>
              <input
                ref={pwRef}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                }}
                className="min-h-tap rounded-md border border-line-strong bg-surface px-3 text-base text-text transition-colors focus:border-accent focus:outline-none"
              />
            </label>
            <Button
              type="submit"
              variant="primary"
              block
              loading={busy}
              disabled={password === "" || waitS > 0}
            >
              {waitS > 0 ? `Try again in ${String(waitS)}s` : "Continue"}
            </Button>
          </form>
        ) : step === "code" ? (
          <div className="flex flex-col gap-4">
            <OtpInput
              value={code}
              onChange={setCode}
              onComplete={(c) => void submitCode(c)}
              disabled={busy || waitS > 0}
              invalid={problem !== null}
            />
            <Button
              variant="primary"
              block
              loading={busy}
              disabled={code.length !== 6 || waitS > 0}
              onClick={() => void submitCode(code)}
            >
              {waitS > 0 ? `Try again in ${String(waitS)}s` : "Sign in"}
            </Button>
            <Button
              variant="ghost"
              block
              onClick={() => {
                setProblem(null);
                setStep("recovery");
              }}
            >
              Lost your phone? Use a recovery code
            </Button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitCode(recovery.trim());
            }}
            className="flex flex-col gap-4"
          >
            <label className="flex flex-col gap-2">
              <span className="eyebrow">Recovery code</span>
              <input
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="XXXX-XXXX-XXXX"
                value={recovery}
                onChange={(e) => {
                  setRecovery(e.target.value);
                }}
                className="num min-h-tap rounded-md border border-line-strong bg-surface px-3 text-center text-lg tracking-wider text-text placeholder:text-faint focus:border-accent focus:outline-none"
              />
            </label>
            <Button
              type="submit"
              variant="primary"
              block
              loading={busy}
              disabled={recovery.trim().length < 12 || waitS > 0}
            >
              Sign in
            </Button>
            <Button
              variant="ghost"
              block
              icon={<ArrowLeft aria-hidden className="size-4" />}
              onClick={() => {
                setProblem(null);
                setStep("code");
              }}
            >
              Back to the 6-digit code
            </Button>
          </form>
        )}

        {problem === null ? null : (
          <ErrorState
            title={problem.text}
            {...(waitS > 0 ? { body: `Locked for ${String(waitS)} more seconds.` } : {})}
          />
        )}
      </main>
    </div>
  );
}
