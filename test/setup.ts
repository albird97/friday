/**
 * Imported first by every test: points Friday at a temp data dir and a fake Claude API, before any
 * src module reads its configuration.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export const ADMIN = { name: "Albert", number: "6281111111111" };
export const WIFE = { name: "Sarah", number: "6282222222222" };

process.env.DOTENV_CONFIG_PATH = path.join(os.tmpdir(), "friday-no-dotenv"); // never read the real .env
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "friday-test-"));
process.env.ALLOWED_CONTACTS = `${ADMIN.name}=${ADMIN.number},${WIFE.name}=${WIFE.number}`;
process.env.ANTHROPIC_API_KEY = "test-key";
delete process.env.ANTHROPIC_AUTH_TOKEN;
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9"; // replaced below once the fake API is listening; never the real API
process.env.DAILY_MESSAGE_LIMIT = "3";
process.env.IMAGE_PROVIDER = "cloudflare";
process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
process.env.CLOUDFLARE_API_TOKEN = "test-token";

type Block = Record<string, unknown> & { type: string };
export type ScriptedReply = { content: Block[]; stop_reason: string; status?: number };
export type Recorded = { headers: http.IncomingHttpHeaders; body: any };

/** A stand-in for the Messages API that replays scripted replies as SSE streams. */
export const claude = {
  replies: [] as ScriptedReply[],
  requests: [] as Recorded[],
  reset() {
    this.replies = [];
    this.requests = [];
  },
};

function sse(reply: ScriptedReply): string {
  const events: [string, unknown][] = [];
  const usage = { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  events.push([
    "message_start",
    { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage } },
  ]);
  reply.content.forEach((block, index) => {
    if (block.type === "text") {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }]);
    } else if (block.type === "tool_use") {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { ...block, input: {} } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }]);
    } else if (block.type === "thinking") {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig-" + index } }]);
    } else {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: block }]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: reply.stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    claude.requests.push({ headers: req.headers, body: JSON.parse(raw || "{}") });
    const reply = claude.replies.shift();
    if (!reply) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "no scripted reply" } }));
      return;
    }
    if (reply.status && reply.status >= 400) {
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "scripted failure" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse(reply));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
