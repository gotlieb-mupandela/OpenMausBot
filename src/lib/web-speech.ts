/** Browser dictation via the Web Speech API (Chrome / Edge). Electron
 * still uses the native Swift helper through `window.ogb`. */

export type SpeechLine = { partial?: boolean; text?: string; error?: string };

type SpeechCtor = new () => {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: {
    resultIndex: number;
    results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
  }) => void) | null;
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
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || "en-US";

  let committed = "";
  let stopped = false;
  let fatal = false;

  rec.onresult = (ev) => {
    let interim = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const piece = ev.results[i][0]?.transcript ?? "";
      if (ev.results[i].isFinal) committed += piece;
      else interim += piece;
    }
    const text = `${committed}${interim}`.replace(/\s+/g, " ").trim();
    opts.onTranscript({ partial: Boolean(interim), text });
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

  rec.onend = () => {
    if (stopped) {
      opts.onEnd({ code: fatal ? 1 : 0 });
      return;
    }
    // Chrome ends the session after a pause — restart while the mic is on.
    try {
      rec.start();
    } catch {
      opts.onEnd({ code: fatal ? 1 : 0 });
    }
  };

  try {
    rec.start();
  } catch {
    opts.onEnd({ code: 1 });
    return () => {};
  }

  return () => {
    stopped = true;
    try {
      rec.stop();
    } catch {
      rec.abort();
    }
  };
}
