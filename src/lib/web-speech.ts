/** Browser dictation via the Web Speech API (Chrome / Edge → Google STT).
 * Electron still uses the native Swift helper through `window.ogb`.
 *
 * Chrome's `continuous: true` mode drops the last phrase on pause and often
 * glues words together. We run one utterance at a time, restart after each
 * pause, map unsupported locales (e.g. en-NA) onto a Google-backed English,
 * and merge overlapping finals so restarts don't duplicate or lose speech. */

export type SpeechLine = { partial?: boolean; text?: string; error?: string };

type SpeechAlt = { transcript: string; confidence?: number };
type SpeechResult = { isFinal: boolean; length: number } & { [i: number]: SpeechAlt };

type SpeechCtor = new () => {
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: { resultIndex: number; results: ArrayLike<SpeechResult> }) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
};

function speechCtor(): SpeechCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function browserSpeechSupported(): boolean {
  return Boolean(speechCtor());
}

/** Locales Google's web recognizer actually trains. Others (en-NA, en-ZW, …)
 * silently degrade to a generic model and garble everyday speech. */
const GOOGLE_LANGS = new Set([
  "af-ZA", "am-ET", "ar-SA", "ar-EG", "az-AZ", "bg-BG", "bn-BD", "bn-IN",
  "ca-ES", "cs-CZ", "da-DK", "de-DE", "el-GR", "en-US", "en-GB", "en-AU",
  "en-CA", "en-IN", "en-IE", "en-NZ", "en-PH", "en-ZA", "en-GH", "en-KE",
  "en-NG", "en-TZ", "es-ES", "es-MX", "es-US", "es-AR", "et-EE", "eu-ES",
  "fa-IR", "fi-FI", "fil-PH", "fr-FR", "fr-CA", "gl-ES", "gu-IN", "he-IL",
  "hi-IN", "hr-HR", "hu-HU", "hy-AM", "id-ID", "is-IS", "it-IT", "ja-JP",
  "jv-ID", "ka-GE", "km-KH", "kn-IN", "ko-KR", "lo-LA", "lt-LT", "lv-LV",
  "ml-IN", "mr-IN", "ms-MY", "my-MM", "nb-NO", "ne-NP", "nl-NL", "pl-PL",
  "pt-BR", "pt-PT", "ro-RO", "ru-RU", "si-LK", "sk-SK", "sl-SI", "sr-RS",
  "su-ID", "sv-SE", "sw-TZ", "sw-KE", "ta-IN", "te-IN", "th-TH", "tr-TR",
  "uk-UA", "ur-PK", "vi-VN", "zh-CN", "zh-TW", "zh-HK", "zu-ZA",
]);

const LANG_FALLBACK: Record<string, string> = {
  en: "en-US",
  // Southern African English is closer to ZA than US.
  "en-na": "en-ZA",
  "en-zw": "en-ZA",
  "en-bw": "en-ZA",
  "en-sz": "en-ZA",
  "en-ls": "en-ZA",
  "en-mw": "en-ZA",
  "en-zm": "en-ZA",
  af: "af-ZA",
  de: "de-DE",
  es: "es-ES",
  fr: "fr-FR",
  pt: "pt-BR",
  zh: "zh-CN",
};

export function recognitionLang(raw = typeof navigator !== "undefined" ? navigator.language : "en-US"): string {
  const tag = (raw || "en-US").replace(/_/g, "-");
  if (GOOGLE_LANGS.has(tag)) return tag;
  const lower = tag.toLowerCase();
  if (LANG_FALLBACK[lower]) return LANG_FALLBACK[lower];
  const prefix = lower.split("-")[0] ?? "en";
  return LANG_FALLBACK[prefix] ?? (GOOGLE_LANGS.has(`${prefix}-${prefix.toUpperCase()}`) ? `${prefix}-${prefix.toUpperCase()}` : "en-US");
}

function bestAlt(result: SpeechResult): string {
  let best = result[0];
  for (let i = 1; i < result.length; i++) {
    const alt = result[i];
    if ((alt?.confidence ?? 0) > (best?.confidence ?? 0)) best = alt;
  }
  return (best?.transcript ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

/** Join two phrases with a space, unless the next bit is punctuation. */
function joinPhrase(left: string, right: string): string {
  const a = left.replace(/\s+/g, " ").trim();
  const b = right.replace(/\s+/g, " ").trim();
  if (!a) return b;
  if (!b) return a;
  if (/^[.,!?;:]/.test(b)) return `${a}${b}`;
  return `${a} ${b}`;
}

/** Drop a repeated prefix when Chrome restates the last words after a restart. */
function mergeUtterance(prev: string, next: string): string {
  const a = prev.replace(/\s+/g, " ").trim();
  const b = next.replace(/\s+/g, " ").trim();
  if (!a) return b;
  if (!b) return a;
  if (b.toLowerCase().startsWith(a.toLowerCase())) return b;
  const aWords = a.split(" ");
  const bWords = b.split(" ");
  const max = Math.min(8, aWords.length, bWords.length);
  for (let n = max; n > 0; n--) {
    if (aWords.slice(-n).join(" ").toLowerCase() === bWords.slice(0, n).join(" ").toLowerCase()) {
      return joinPhrase(aWords.slice(0, -n).join(" "), b);
    }
  }
  return joinPhrase(a, b);
}

/** Start listening. Returns a stop function. `onEnd` code 1 = permission / fatal. */
export function startBrowserSpeech(opts: {
  onTranscript: (line: SpeechLine) => void;
  onEnd: (info: { code: number | null }) => void;
}): () => void {
  const Ctor = speechCtor();
  if (!Ctor) {
    opts.onEnd({ code: 1 });
    return () => {};
  }

  const rec = new Ctor();
  // One utterance per session is more accurate than Chrome's continuous mode.
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 3;
  rec.lang = recognitionLang();

  let committed = "";
  let interim = "";
  let stopped = false;
  let fatal = false;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  const emit = (partial: boolean) => {
    const text = joinPhrase(committed, interim);
    if (!text && partial) return;
    opts.onTranscript({ partial, text });
  };

  rec.onresult = (ev) => {
    let nextInterim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const piece = bestAlt(ev.results[i]);
      if (!piece) continue;
      if (ev.results[i].isFinal) {
        committed = mergeUtterance(committed, piece);
        nextInterim = "";
      } else {
        nextInterim = joinPhrase(nextInterim, piece);
      }
    }
    interim = nextInterim;
    emit(Boolean(interim));
  };

  rec.onerror = (ev) => {
    const err = ev.error ?? "";
    if (err === "aborted" || err === "no-speech") return;
    if (err === "not-allowed" || err === "service-not-allowed") {
      fatal = true;
      opts.onTranscript({ error: err });
      return;
    }
    if (err === "network") {
      fatal = true;
      opts.onTranscript({ error: "network" });
    }
  };

  const restart = () => {
    if (stopped || fatal) return;
    try {
      rec.start();
    } catch {
      opts.onEnd({ code: fatal ? 1 : 0 });
    }
  };

  rec.onend = () => {
    if (interim) {
      committed = mergeUtterance(committed, interim);
      interim = "";
      emit(false);
    }
    if (stopped || fatal) {
      opts.onEnd({ code: fatal ? 1 : 0 });
      return;
    }
    // Let Chrome fully release the previous session before starting another.
    restartTimer = setTimeout(restart, 120);
  };

  try {
    rec.start();
  } catch {
    opts.onEnd({ code: 1 });
    return () => {};
  }

  return () => {
    stopped = true;
    if (restartTimer) clearTimeout(restartTimer);
    try {
      rec.stop();
    } catch {
      rec.abort();
    }
  };
}
