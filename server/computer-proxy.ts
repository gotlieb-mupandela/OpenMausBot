// computer-proxy — MCP stdio server for Claude CLI; thin wrapper over computer-tools.
// stdout is the MCP channel — never console.log here.
import { createComputerSession, COMPUTER_TOOL_DEFS } from "./computer-tools.ts";

const boxId = process.env.OGB_BOX_ID ?? "";
const token = process.env.OGB_BOX_TOKEN ?? "";
const session = boxId && token ? createComputerSession({ boxId, token }) : null;

const send = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
const text = (id: unknown, t: string, isError = false) =>
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) } });

const TOOLS = COMPUTER_TOOL_DEFS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.parameters,
}));

async function call(id: unknown, name: string, args: any) {
  if (!session) return text(id, "computer not configured (missing OGB_BOX_ID / OGB_BOX_TOKEN)", true);
  const result = await session.call(name, args ?? {});
  if (result.ok && result.image) {
    return send({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "image", data: result.image.data, mimeType: result.image.mimeType }] },
    });
  }
  return text(id, result.text, !result.ok);
}

async function handle(msg: any) {
  if (msg.method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "aishe-computer", version: "3" },
      },
    });
  }
  if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  if (msg.method === "tools/call") {
    try {
      return await call(msg.id, msg.params?.name, msg.params?.arguments ?? {});
    } catch (e) {
      return text(msg.id, `computer tool failed: ${(e as Error).message}`, true);
    }
  }
  if (String(msg.method ?? "").startsWith("notifications/")) return;
  if (msg.id != null) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
}

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      void handle(JSON.parse(line));
    } catch {
      /* ignore malformed lines */
    }
  }
});
process.stdin.on("end", () => process.exit(0));
