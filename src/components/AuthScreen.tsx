import { useEffect, useState } from "react";
import { MausAvatar } from "./Avatar";

export interface SaasUser {
  id: string;
  email: string;
  name: string;
  needsOnboarding?: boolean;
}

export function AuthScreen({ googleAuth = false }: { onAuthed?: (user: SaasUser) => void; googleAuth?: boolean }) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get("auth_error");
    if (!q) return;
    setError(q);
    params.delete("auth_error");
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}`;
    window.history.replaceState({}, "", next);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-app p-0 sm:items-center sm:p-4">
      <div className="my-auto flex w-full max-w-[420px] flex-col rounded-t-2xl border border-hairline/40 bg-panel p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:rounded-2xl sm:p-8">
        <div className="flex flex-col items-center">
          <MausAvatar color="blue" state="happy" size={64} />
          <h1 className="mt-4 text-[22px] font-semibold text-ink">OpenMausBot</h1>
          <p className="mt-1.5 text-center text-[14px] text-ink-secondary">
            Your AI bot team in the cloud — sign in with Google to continue.
          </p>
        </div>

        <div className="mt-6 flex flex-col gap-3">
          <a
            href="/api/auth/google"
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white hover:brightness-110"
          >
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden fill="currentColor">
              <path d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z" />
              <path d="M6.3 14.7l6.6 4.8C14.7 16 19 12 24 12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
              <path d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-7.9l-6.5 5C9.6 39.6 16.3 44 24 44z" />
              <path d="M43.6 20.5H42V20H24v8h11.3c-1.1 3.2-3.5 5.7-6.6 7.2l6.3 5.3C38.3 37.3 44 31.5 44 24c0-1.3-.1-2.7-.4-3.5z" />
            </svg>
            Continue with Google
          </a>
          {error && <div className="text-center text-[13px] text-danger">{error}</div>}
          {!googleAuth && (
            <p className="text-center text-[12px] text-ink-secondary">
              Google sign-in isn&apos;t configured on this server yet.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
