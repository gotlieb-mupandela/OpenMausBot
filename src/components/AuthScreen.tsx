import { useState } from "react";
import { Loader2 } from "lucide-react";
import { MausAvatar } from "./Avatar";

export interface SaasUser {
  id: string;
  email: string;
  name: string;
  subscriptionStatus: string;
  subscriptionEndsAt: number | null;
  plan: { id: string; name: string; priceLabel: string };
  canChat: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function friendlyAuthError(raw: string): string {
  const msg = raw.toLowerCase();
  if (msg.includes("invalid email or password")) return "Incorrect email or password.";
  if (msg.includes("invalid email")) return "Enter a valid email address (like you@example.com).";
  if (msg.includes("password must be")) return "Password must be at least 8 characters.";
  if (msg.includes("already registered")) return "That email is already registered. Try logging in.";
  return raw;
}

export function AuthScreen({
  onAuthed,
  googleAuth = false,
}: {
  onAuthed: (user: SaasUser) => void;
  googleAuth?: boolean;
}) {
  const [mode, setMode] = useState<"login" | "signup">("signup");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get("auth_error");
    if (q) {
      params.delete("auth_error");
      const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}`;
      window.history.replaceState({}, "", next);
    }
    return q;
  });

  const emailOk = EMAIL_RE.test(email.trim());
  const passwordOk = mode === "signup" ? password.length >= 8 : password.length >= 1;
  const canSubmit = emailOk && passwordOk && !busy;

  const switchMode = (next: "login" | "signup") => {
    setMode(next);
    setError(null);
  };

  const submit = async () => {
    if (!EMAIL_RE.test(email.trim())) {
      setError("Enter a valid email address (like you@example.com).");
      return;
    }
    if (mode === "signup" && password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(mode === "signup" ? "/api/auth/signup" : "/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          mode === "signup" ? { name, email, password } : { email, password },
        ),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      onAuthed(data.user);
    } catch (e) {
      setError(friendlyAuthError(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-app p-0 sm:items-center sm:p-4">
      <div className="my-auto flex w-full max-w-[420px] flex-col rounded-t-2xl border border-hairline/40 bg-panel p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:rounded-2xl sm:p-8">
        <div className="flex flex-col items-center">
          <MausAvatar color="green" state="happy" size={64} />
          <h1 className="mt-4 text-[22px] font-semibold text-ink">OpenMausBot</h1>
          <p className="mt-1.5 text-center text-[14px] text-ink-secondary">
            Your AI bot team in the cloud — {mode === "signup" ? "create an account" : "welcome back"}.
          </p>
        </div>

        <div className="mt-5 flex rounded-lg border border-hairline/40 p-1">
          {(["signup", "login"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => switchMode(m)}
              className={`flex-1 rounded-md py-1.5 text-[13px] capitalize ${
                mode === m ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink"
              }`}
            >
              {m === "signup" ? "Sign up" : "Log in"}
            </button>
          ))}
        </div>

        <form
          className="mt-4 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {googleAuth && (
            <>
              <a
                href="/api/auth/google"
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-hairline/40 bg-raised py-2.5 text-[15px] font-medium text-ink hover:bg-raised-hover"
              >
                <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
                  <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z" />
                  <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 12 24 12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
                  <path fill="#4CAF50" d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-7.9l-6.5 5C9.6 39.6 16.3 44 24 44z" />
                  <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-1.1 3.2-3.5 5.7-6.6 7.2l6.3 5.3C38.3 37.3 44 31.5 44 24c0-1.3-.1-2.7-.4-3.5z" />
                </svg>
                Continue with Google
              </a>
              <div className="flex items-center gap-3 text-[12px] text-ink-secondary">
                <span className="h-px flex-1 bg-hairline/40" />
                or
                <span className="h-px flex-1 bg-hairline/40" />
              </div>
            </>
          )}
          {mode === "signup" && (
            <input
              name="name"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
            />
          )}
          <input
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (error) setError(null);
            }}
            placeholder="you@example.com"
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
          />
          <input
            type="password"
            name="password"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError(null);
            }}
            placeholder={mode === "signup" ? "Password (8+ characters)" : "Password"}
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
          />
          {error && <div className="text-[13px] text-danger">{error}</div>}
          <button
            type="submit"
            disabled={!canSubmit}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white disabled:opacity-40"
          >
            {busy && <Loader2 size={16} className="animate-spin" />}
            {mode === "signup" ? "Start free trial" : "Log in"}
          </button>
          {mode === "signup" && (
            <p className="text-center text-[12px] text-ink-secondary">
              Includes a 14-day trial of Pro ($29/mo). AI is included — nothing to set up.
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
