// PostHog usage analytics + the email → person identity link.
// Loaded after first paint — the SDK is large and is not needed to render chat.
const TOKEN = "phc_m2hP39w8y2gLPvHgDvSXAu6xcZ3agjf4ruL56rGcMZEe";

type Posthog = typeof import("posthog-js").default;

let posthog: Posthog | null = null;
let loading: Promise<Posthog> | null = null;

function loadPosthog(): Promise<Posthog> {
  if (posthog) return Promise.resolve(posthog);
  if (!loading) {
    loading = import("posthog-js").then(({ default: ph }) => {
      ph.init(TOKEN, {
        api_host: "https://us.i.posthog.com",
        autocapture: true,
        capture_pageview: false,
        person_profiles: "identified_only",
        persistence: "localStorage",
      });
      posthog = ph;
      return ph;
    });
  }
  return loading;
}

function platform() {
  return navigator.userAgent.includes("Electron") ? "desktop" : "browser";
}

let started = false;

export function initAnalytics() {
  if (started) return;
  started = true;
  const start = () => {
    void loadPosthog().then((ph) => {
      if (!localStorage.getItem("omb-installed")) {
        localStorage.setItem("omb-installed", new Date().toISOString());
        ph.capture("app_first_open", { platform: platform() });
      }
      ph.capture("app_opened", { platform: platform() });
    });
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(start, { timeout: 2500 });
  } else {
    setTimeout(start, 1);
  }
}

export function track(event: string, props?: Record<string, unknown>) {
  void loadPosthog().then((ph) => ph.capture(event, props));
}

export function identifyEmail(email: string) {
  void loadPosthog().then((ph) => {
    ph.identify(email, { email });
    ph.capture("email_submitted");
  });
}

const GATE_KEY = "omb-email-gate";
export function emailGateDone(): boolean {
  return Boolean(localStorage.getItem(GATE_KEY));
}
export function setEmailGateDone(status: "submitted" | "skipped") {
  localStorage.setItem(GATE_KEY, status);
}
