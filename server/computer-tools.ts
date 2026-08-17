// Shared cloud-computer tool implementations (Box REST + xdotool/CUA).
// Used by the Claude MCP proxy and the Ollama in-process tool loop.
const BOX_API = "https://ascii.dev/api/box/v1";
export const COMPUTER_SHOT_WIDTH = 1280;

export type ComputerCreds = { boxId: string; token: string };

export type ComputerToolResult =
  | { ok: true; text: string; image?: { data: string; mimeType: string } }
  | { ok: false; text: string };

export const COMPUTER_TOOL_DEFS = [
  {
    name: "screenshot",
    description:
      "See the shared cloud computer screen (returns an image). Call before and after acting — the desktop runs Chrome and a full Linux GUI.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "click",
    description:
      "Click on the computer's screen. Use pixel coordinates from the most recent screenshot — scaling is handled for you.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right"] },
        double: { type: "boolean" },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
  },
  {
    name: "type_text",
    description: "Type text at the current focus on the computer.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "press_key",
    description: 'Press a key or chord (xdotool): "Return", "Tab", "ctrl+c", "alt+F4".',
    parameters: {
      type: "object",
      properties: { keys: { type: "string" } },
      required: ["keys"],
      additionalProperties: false,
    },
  },
  {
    name: "scroll",
    description: "Scroll the computer screen up or down by N clicks.",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"] },
        clicks: { type: "number" },
      },
      required: ["direction"],
      additionalProperties: false,
    },
  },
  {
    name: "computer_exec",
    description: "Run a shell command on the cloud computer (Linux, passwordless sudo, X11).",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "open_url",
    description: "Open a URL in the computer's Chrome, then screenshot to see the result.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
  },
] as const;

const SHOT_CMD = [
  "export DISPLAY=${DISPLAY:-:0}",
  "f=/tmp/ogb-shot.png",
  'scrot -o "$f" 2>/dev/null || import -window root "$f" 2>/dev/null || ffmpeg -y -f x11grab -i "$DISPLAY" -frames:v 1 "$f" >/dev/null 2>&1',
  `command -v convert >/dev/null && convert "$f" -resize ${COMPUTER_SHOT_WIDTH}x "$f" 2>/dev/null || true`,
  'test -s "$f" && echo captured',
].join("; ");

const X = "export DISPLAY=${DISPLAY:-:0}; ";

async function runOnBox(creds: ComputerCreds, command: string, timeoutMs = 60_000) {
  const res = await fetch(`${BOX_API}/boxes/${creds.boxId}/commands`, {
    method: "POST",
    headers: { authorization: `Bearer ${creds.token}`, "content-type": "application/json" },
    body: JSON.stringify({ command }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body: any = await res.json().catch(() => null);
  return {
    ok: res.ok && body?.exitCode === 0,
    exitCode: body?.exitCode ?? null,
    stdout: body?.stdout ?? "",
    stderr: body?.stderr ?? "",
  };
}

async function cuaCmd(creds: ComputerCreds, command: string, params: Record<string, unknown>, timeoutMs = 30_000) {
  const payload = JSON.stringify({ command, params }).replace(/'/g, "'\\''");
  const out = await runOnBox(
    creds,
    `curl -sf -m ${Math.floor(timeoutMs / 1000)} -X POST http://127.0.0.1:8000/cmd -H 'Content-Type: application/json' -d '${payload}'`,
    timeoutMs + 15_000,
  );
  if (!out.ok || !out.stdout.trim()) return null;
  const line = out.stdout.split("\n").find((l: string) => l.startsWith("data: "));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(6));
    return parsed?.success === false ? null : parsed;
  } catch {
    return null;
  }
}

async function readBoxFile(creds: ComputerCreds, path: string): Promise<string | null> {
  const res = await fetch(
    `${BOX_API}/boxes/${creds.boxId}/files?path=${encodeURIComponent(path)}&encoding=base64`,
    { headers: { authorization: `Bearer ${creds.token}` }, signal: AbortSignal.timeout(30_000) },
  );
  const body: any = await res.json().catch(() => null);
  const content = body?.content;
  return res.ok && typeof content === "string" && content ? content : null;
}

async function displayGeometry(creds: ComputerCreds, cache: { current?: { width: number; height: number } | null }) {
  if (cache.current !== undefined) return cache.current;
  const out = await runOnBox(creds, `${X}xdotool getdisplaygeometry`);
  const m = out.stdout.trim().match(/^(\d+)\s+(\d+)/);
  cache.current = m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  return cache.current;
}

export function createComputerSession(creds: ComputerCreds) {
  const geometryCache: { current?: { width: number; height: number } | null } = {};

  return {
    async call(name: string, args: Record<string, unknown> = {}): Promise<ComputerToolResult> {
      try {
        if (name === "screenshot") {
          const out = await runOnBox(creds, SHOT_CMD, 60_000);
          if (!/captured/.test(out.stdout)) {
            return { ok: false, text: `screenshot failed: ${out.stderr.slice(0, 200) || "capture produced no file"}` };
          }
          const data = await readBoxFile(creds, "/tmp/ogb-shot.png");
          if (!data) return { ok: false, text: "screenshot failed: could not read the frame back" };
          return { ok: true, text: "screenshot captured", image: { data, mimeType: "image/png" } };
        }
        if (name === "click") {
          const x = Math.round(Number(args.x));
          const y = Math.round(Number(args.y));
          if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, text: "click needs numeric x,y" };
          const geometry = await displayGeometry(creds, geometryCache);
          const scale = geometry ? geometry.width / COMPUTER_SHOT_WIDTH : 1;
          const sx = Math.round(x * scale);
          const sy = Math.round(y * scale);
          const btn = args.button === "right" ? 3 : 1;
          const rep = args.double ? "--repeat 2 --delay 150 " : "";
          const out = await runOnBox(creds, `${X}xdotool mousemove ${sx} ${sy} click ${rep}${btn}`);
          if (!out.ok) return { ok: false, text: `click failed: ${out.stderr.slice(0, 200)}` };
          return {
            ok: true,
            text: `clicked ${x},${y}${scale !== 1 ? ` (scaled to ${sx},${sy})` : ""}${args.double ? " (double)" : ""} — screenshot to verify`,
          };
        }
        if (name === "type_text") {
          const t = String(args.text ?? "");
          if (!t) return { ok: false, text: "nothing to type" };
          const cua = await cuaCmd(creds, "type_text", { text: t });
          if (!cua) {
            const safe = t.replace(/'/g, "'\\''");
            const out = await runOnBox(creds, `${X}xdotool type --delay 12 '${safe}'`);
            if (!out.ok) return { ok: false, text: `type failed: ${out.stderr.slice(0, 200)}` };
          }
          return { ok: true, text: `typed ${t.length} chars` };
        }
        if (name === "press_key") {
          const keys = String(args.keys ?? "").replace(/[^\w+]/g, "");
          if (!keys) return { ok: false, text: "press_key needs keys" };
          const out = await runOnBox(creds, `${X}xdotool key ${keys}`);
          return out.ok ? { ok: true, text: `pressed ${keys}` } : { ok: false, text: `key failed: ${out.stderr.slice(0, 200)}` };
        }
        if (name === "scroll") {
          const clicks = Math.min(Math.max(Math.round(Number(args.clicks) || 3), 1), 20);
          const command = args.direction === "up" ? "scroll_up" : "scroll_down";
          const cua = await cuaCmd(creds, command, { clicks });
          if (!cua) {
            const btn = args.direction === "up" ? 4 : 5;
            const out = await runOnBox(creds, `${X}xdotool click --repeat ${clicks} ${btn}`);
            if (!out.ok) return { ok: false, text: `scroll failed: ${out.stderr.slice(0, 200)}` };
          }
          return { ok: true, text: `scrolled ${args.direction} ${clicks}` };
        }
        if (name === "computer_exec") {
          const out = await runOnBox(creds, String(args.command ?? "").slice(0, 4000), 120_000);
          return {
            ok: true,
            text: `exit ${out.exitCode}\n${out.stdout.slice(-6000)}${out.stderr ? `\n[stderr]\n${out.stderr.slice(-2000)}` : ""}`,
          };
        }
        if (name === "open_url") {
          const url = String(args.url ?? "");
          if (!/^https?:\/\//.test(url)) return { ok: false, text: "only http(s) URLs" };
          const q = url.replace(/'/g, "%27");
          await runOnBox(
            creds,
            `${X}(google-chrome '${q}' || chromium '${q}' || chromium-browser '${q}' || xdg-open '${q}') >/dev/null 2>&1 & sleep 3; echo opened`,
            30_000,
          );
          return { ok: true, text: `opened ${url} — take a screenshot to see it` };
        }
        return { ok: false, text: `unknown tool ${name}` };
      } catch (e) {
        return { ok: false, text: `computer tool failed: ${(e as Error).message}` };
      }
    },
  };
}

/** OpenAI-compatible tool schemas for Ollama / chat completions. */
export function computerToolsOpenAI() {
  return COMPUTER_TOOL_DEFS.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
