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
  if (msg.includes("invalid email")) return "Enter a valid email address (like you@example.com).";
  if (msg.includes("password must be")) return "Password must be at least 8 characters.";
  if (msg.includes("already registered")) return "That email is already registered. Try logging in.";
  if (msg.includes("invalid email or password")) return "Incorrect email or password.";
  return raw;
}

export function AuthScreen({ onAuthed }: { onAuthed: (user: SaasUser) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("signup");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
              Includes a 14-day trial of Pro ($29/mo). Models are hosted for you — no API keys to manage.
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
