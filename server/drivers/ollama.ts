// Ollama Cloud driver — OpenAI-compatible chat completions against
// https://ollama.com/v1 with optional in-process computer / Composio tools.
import type {
  DriverCreateInput,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { createComputerSession, computerToolsOpenAI } from "../computer-tools.ts";
import * as composio from "../composio.ts";
import { appendNative } from "./native.ts";

const DRIVER_KIND = "ollama";
const DEFAULT_URL = "https://ollama.com/v1";
const MAX_TOOL_ROUNDS = 12;

const MODELS = {
  default: "gpt-oss:120b",
  options: [
    { id: "gpt-oss:120b", label: "GPT-OSS 120B" },
    { id: "gpt-oss:20b", label: "GPT-OSS 20B" },
    { id: "gemma4:31b", label: "Gemma 4 31B" },
    { id: "qwen3.5:397b", label: "Qwen 3.5 397B" },
    { id: "deepseek-v4-flash:preview", label: "DeepSeek V4 Flash" },
    { id: "kimi-k2.6", label: "Kimi K2.6" },
  ],
};

export interface OllamaConfig {
  url: string;
  apiKeyEnv: string;
}

function decodeConfig(raw: unknown): OllamaConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    url: typeof o.url === "string" ? o.url : DEFAULT_URL,
    apiKeyEnv: typeof o.apiKeyEnv === "string" ? o.apiKeyEnv : "OLLAMA_API_KEY",
  };
}

type ChatMessage = {
  role: string;
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type?: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
};

export const OllamaDriver: ProviderDriver<OllamaConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Ollama Cloud", supportsMultipleInstances: true },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<OllamaConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const apiKey = input.environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "";
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { abort: AbortController; turnId: string }>();

    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const complete = async (
      messages: ChatMessage[],
      model: string,
      opts: {
        stream: boolean;
        signal?: AbortSignal;
        tools?: unknown[];
        onDelta?: (d: string) => void;
      },
    ): Promise<{
      text: string;
      usage: { input: number; output: number } | null;
      toolCalls: ChatMessage["tool_calls"];
      finishReason: string | null;
    }> => {
      const body: Record<string, unknown> = {
        model,
        messages,
        stream: opts.stream && !opts.tools?.length,
      };
      if (opts.tools?.length) {
        body.tools = opts.tools;
        body.stream = false;
      }
      const res = await fetch(`${config.url}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: opts.signal ?? AbortSignal.timeout(180_000),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`Ollama HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 200)}` : ""}`);
      }

      // Tool rounds are non-streaming JSON responses.
      if (!body.stream) {
        const json: any = await res.json();
        const msg = json.choices?.[0]?.message ?? {};
        const text = typeof msg.content === "string" ? msg.content : "";
        const toolCalls = msg.tool_calls;
        if (!opts.tools?.length && text && opts.onDelta) opts.onDelta(text);
        return {
          text,
          usage: json.usage
            ? { input: json.usage.prompt_tokens ?? 0, output: json.usage.completion_tokens ?? 0 }
            : null,
          toolCalls: Array.isArray(toolCalls) ? toolCalls : undefined,
          finishReason: json.choices?.[0]?.finish_reason ?? null,
        };
      }

      let text = "";
      let usage: { input: number; output: number } | null = null;
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let chunk: any;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            text += delta;
            opts.onDelta?.(delta);
          }
          if (chunk.usage) {
            usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
          }
        }
      }
      return { text, usage, toolCalls: undefined, finishReason: null };
    };

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (!apiKey) throw new Error(`no Ollama key — set ${config.apiKeyEnv} or config.json ollama.key`);
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      const abort = new AbortController();
      active.set(threadId, { abort, turnId });

      const messages: ChatMessage[] = [
        ...(turn.system ? [{ role: "system", content: turn.system }] : []),
        ...(turn.transcript ?? []).map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.text,
        })),
        { role: "user", content: turn.text },
      ];

      // Emit started before any Composio listing so interrupt/busy UI can progress.
      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({
        ...base(threadId, turnId),
        type: "session.started",
        sessionId: null,
        model: turn.model ?? MODELS.default,
      });

      (async () => {
        try {
          const tools: unknown[] = [];
          const computerNames = new Set<string>();
          let computerSession: ReturnType<typeof createComputerSession> | null = null;
          if (turn.integrations?.computer) {
            computerSession = createComputerSession(turn.integrations.computer);
            for (const t of computerToolsOpenAI()) {
              tools.push(t);
              computerNames.add(t.function.name);
            }
          }

          const composioCfg = turn.integrations?.composio;
          const hasComposio = Boolean(
            composioCfg &&
              (composio.resolveConnectKey({ composio: composioCfg }) ||
                composio.resolveApiKey({ composio: composioCfg })),
          );
          const composioUserId = composioCfg?.userId;
          const light = composio.isLightChatTurn(turn.text);
          if (hasComposio && composioCfg && !light) {
            try {
              const composioOpenAI = await composio.listToolsOpenAI(
                { composio: composioCfg },
                composioUserId,
                { signal: abort.signal, preferToolkit: composioCfg.preferToolkit },
              );
              if (abort.signal.aborted) {
                const err = new Error("interrupted");
                err.name = "AbortError";
                throw err;
              }
              tools.push(...composioOpenAI);
              if (composioOpenAI.length) {
                console.log(
                  `[ollama] composio tools: ${composioOpenAI.length} (${composioOpenAI
                    .slice(0, 8)
                    .map((t) => t.function.name)
                    .join(", ")}${composioOpenAI.length > 8 ? ", …" : ""})`,
                );
              } else {
                console.warn("[ollama] composio configured but no tools listed for this user");
              }
            } catch (e) {
              if ((e as Error).name === "AbortError") throw e;
              console.warn("[ollama] composio listTools failed:", e instanceof Error ? e.message : e);
            }
          } else if (hasComposio && light) {
            console.log("[ollama] skipping composio tools for light turn");
          }

          appendNative(threadId, {
            dir: "out",
            source: "ollama.chat.completions",
            msg: {
              model: turn.model,
              messages,
              tools: tools.map((t: any) => t.function?.name).filter(Boolean),
            },
          });

          let usageTotal: { input: number; output: number } | null = null;
          let finalText = "";
          for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            if (abort.signal.aborted) {
              const err = new Error("interrupted");
              err.name = "AbortError";
              throw err;
            }
            const useTools = tools.length > 0 && round < MAX_TOOL_ROUNDS - 1;
            // When tools are enabled we disable streaming, so onDelta only
            // fires on the final text round — never reference toolCalls here
            // (TDZ: it's declared by this destructuring).
            const { text, usage, toolCalls } = await complete(messages, turn.model || MODELS.default, {
              stream: !useTools,
              signal: abort.signal,
              tools: useTools ? tools : undefined,
              onDelta: (delta) => {
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
              },
            });
            if (usage) {
              usageTotal = usageTotal
                ? { input: usageTotal.input + usage.input, output: usageTotal.output + usage.output }
                : usage;
            }

            if (!toolCalls?.length) {
              finalText = text;
              // Tool rounds are non-streaming — surface the final text as deltas
              // when we never streamed (so the UI is not blank until complete).
              if (useTools && text.trim()) {
                emit({
                  ...base(threadId, turnId),
                  type: "content.delta",
                  streamKind: "assistant_text",
                  delta: text,
                });
              }
              break;
            }

            messages.push({
              role: "assistant",
              content: text || null,
              tool_calls: toolCalls,
            });

            for (const tc of toolCalls) {
              if (abort.signal.aborted) {
                const err = new Error("interrupted");
                err.name = "AbortError";
                throw err;
              }
              const name = tc.function?.name ?? "tool";
              const itemId = tc.id || newId();
              let args: Record<string, unknown> = {};
              try {
                args = JSON.parse(tc.function?.arguments || "{}");
              } catch {
                args = {};
              }
              emit({
                ...base(threadId, turnId),
                type: "item.started",
                itemType: "tool",
                itemId,
                title: name,
              });

              let resultText = "";
              let ok = true;
              if (computerNames.has(name) && computerSession) {
                const result = await computerSession.call(name, args);
                ok = result.ok;
                resultText = result.text;
                if (result.ok && result.image) {
                  resultText += `\n[screenshot captured — ${result.image.mimeType}]`;
                  appendNative(threadId, {
                    dir: "in",
                    source: "ollama.computer.screenshot",
                    msg: { mimeType: result.image.mimeType, bytes: result.image.data.length },
                  });
                }
              } else if (hasComposio && composioCfg) {
                try {
                  const toolArgs = composio.normalizeComposioToolArgs(name, args);
                  const out = await composio.callTool(
                    { composio: composioCfg },
                    name,
                    toolArgs,
                    composioUserId,
                  );
                  resultText = composio.formatComposioToolResult(name, out, 24_000);
                } catch (e) {
                  ok = false;
                  resultText = (e as Error).message;
                }
              } else {
                ok = false;
                resultText = `unknown tool ${name}`;
              }

              emit({
                ...base(threadId, turnId),
                type: "item.completed",
                itemType: "tool",
                itemId,
                ok,
              });

              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                name,
                content: resultText.slice(0, 24_000),
              });
            }
          }

          appendNative(threadId, {
            dir: "in",
            source: "ollama.chat.completions",
            msg: { text: finalText, usage: usageTotal },
          });
          if (finalText.trim()) {
            emit({
              ...base(threadId, turnId),
              type: "item.completed",
              itemType: "assistant_text",
              text: finalText,
            });
          }
          if (usageTotal) {
            emit({ ...base(threadId, turnId), type: "thread.token-usage.updated", ...usageTotal });
          }
          active.delete(threadId);
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: null, cost: null });
        } catch (e) {
          active.delete(threadId);
          const aborted = (e as Error).name === "AbortError";
          if (!aborted) {
            emit({ ...base(threadId, turnId), type: "runtime.error", message: (e as Error).message });
          }
          emit({
            ...base(threadId, turnId),
            type: "turn.completed",
            ok: false,
            stopReason: aborted ? "interrupted" : "error",
            cost: null,
          });
        }
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      if (!apiKey) {
        return {
          state: "unavailable",
          reason: `no Ollama API key — add {"ollama":{"key":"…"}} in App Settings or set ${config.apiKeyEnv}`,
        };
      }
      return { state: "available", authenticated: true, version: null };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models: MODELS,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "in-session", toolsInProcess: true },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
        respondToRequest: async () => {
          throw new Error("ollama driver has no pending asks");
        },
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { abort } of active.values()) abort.abort();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: async (prompt: string) => {
        const { text } = await complete([{ role: "user", content: prompt }], "gpt-oss:20b", { stream: false });
        return text;
      },
      dispose: async () => {
        for (const { abort } of active.values()) abort.abort();
        listeners.clear();
      },
    };
  },
};
