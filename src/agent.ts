import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { config } from "./config.js";
import { chunk, toWhatsApp } from "./format.js";
import { memoriesFor, SHARED } from "./memory.js";
import { buildSystemPrompt } from "./prompt.js";
import { isStale, loadSession, recapOf, saveSession, type Session } from "./session.js";
import { runTool, toolParams } from "./tools.js";
import type { ChatContext, Outbox } from "./types.js";

let client: Anthropic | undefined; // created on first use, once the environment is fully configured

const MAX_STEPS = 12;
const BETAS = [
  "server-side-fallback-2026-07-01", // fallbacks: "default" — if a safety classifier declines, retry on a fallback model
  "thinking-binding-controls-2026-08-01", // drop (rather than reject) thinking blocks if the history ever mismatches
];

function startSession(chat: ChatContext, previous: Session | undefined): Session {
  const owners = [SHARED, chat.isGroup ? chat.chatId : chat.sender.number];
  const recap = previous ? recapOf(previous.messages) : "";
  return { system: buildSystemPrompt(chat, memoriesFor(owners), recap), messages: [], tokens: 0, updatedAt: Date.now() };
}

/**
 * After a mid-answer fallback, blocks before the last `fallback` marker that belong to the declined model
 * (thinking, unfinished tool calls) must not be sent back. Everything else is replayed verbatim.
 */
function echoable(content: BetaContentBlock[]): BetaContentBlockParam[] {
  const boundary = content.findLastIndex((b) => b.type === "fallback");
  if (boundary < 0) return content as BetaContentBlockParam[];
  const answered = new Set(content.flatMap((b) => ("tool_use_id" in b ? [b.tool_use_id] : [])));
  return content.filter(
    (b, i) =>
      i >= boundary ||
      b.type === "text" ||
      (b.type === "server_tool_use" && answered.has(b.id)) ||
      ("tool_use_id" in b && answered.has(b.tool_use_id)),
  ) as BetaContentBlockParam[];
}

/** Runs Claude until it has answered, executing tools along the way. Returns false on a refusal. */
async function runTurn(session: Session, chat: ChatContext, outbox: Outbox): Promise<boolean> {
  for (let step = 0; step < MAX_STEPS; step++) {
    await outbox.typing(chat.chatId);
    client ??= new Anthropic({ maxRetries: 3 });
    const response = await client.beta.messages
      .stream({
        model: config.FRIDAY_MODEL,
        max_tokens: 32_000,
        betas: BETAS,
        fallbacks: "default",
        thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
        output_config: { effort: config.FRIDAY_EFFORT },
        cache_control: { type: "ephemeral" },
        system: session.system,
        tools: toolParams,
        messages: session.messages,
      })
      .finalMessage();

    const u = response.usage;
    session.tokens = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + u.output_tokens;
    console.log(
      `[${chat.chatName}] ${response.model} ${response.stop_reason}: in ${u.input_tokens} + cached ${u.cache_read_input_tokens ?? 0} + written ${u.cache_creation_input_tokens ?? 0}, out ${u.output_tokens}`,
    );

    if (response.stop_reason === "refusal") {
      await outbox.sendText(chat.chatId, "Sorry, I can't help with that one.", chat.replyTo);
      return false;
    }

    session.messages.push({ role: "assistant", content: echoable(response.content) });

    const text = toWhatsApp(
      response.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join(""),
    );
    for (const part of text ? chunk(text) : []) await outbox.sendText(chat.chatId, part, chat.replyTo);

    if (response.stop_reason === "pause_turn") continue; // server-side web tools want another round

    const toolUses = response.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) return true;

    const results = await Promise.all(
      toolUses.map(async (use): Promise<BetaToolResultBlockParam> => {
        if (response.stop_reason === "max_tokens") {
          return {
            type: "tool_result",
            tool_use_id: use.id,
            is_error: true,
            content: "Your output hit the length limit, so this input was cut off. Retry with shorter content.",
          };
        }
        const result = await runTool(use.name, use.input, { chat, outbox });
        console.log(`[${chat.chatName}] tool ${use.name}${result.isError ? " ERROR" : ""}: ${result.content.slice(0, 200)}`);
        return { type: "tool_result", tool_use_id: use.id, content: result.content, ...(result.isError && { is_error: true }) };
      }),
    );
    session.messages.push({ role: "user", content: results });
  }

  await outbox.sendText(chat.chatId, "That took more steps than I allow myself. Tell me how you'd like to continue.", chat.replyTo);
  return true;
}

function errorReply(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "My Claude API key isn't working. (Admin: check ANTHROPIC_API_KEY in .env.)";
  if (err instanceof Anthropic.PermissionDeniedError) return "My Claude API key isn't allowed to do that. (Admin: check the key's permissions and model access.)";
  if (err instanceof Anthropic.RateLimitError) return "I'm getting too many requests right now. Try again in a minute.";
  if (err instanceof Anthropic.BadRequestError) {
    return "Something in that message tripped me up (maybe a file that's too large or unsupported). Try again, or send /reset to start fresh.";
  }
  if (err instanceof Anthropic.APIConnectionError) return "I can't reach Claude right now. Check the internet connection and try again.";
  if (err instanceof Anthropic.APIError) return "Claude is having trouble right now. Try again in a moment.";
  return "Sorry, something went wrong on my side. Please try again.";
}

/** Answers one incoming message in `chat`. `content` is the user's turn (text, images, documents). */
export async function respond(chat: ChatContext, content: BetaContentBlockParam[], outbox: Outbox): Promise<void> {
  const previous = loadSession(chat.chatId);
  const session = previous && !isStale(previous) ? previous : startSession(chat, previous);
  const checkpoint = session.messages.length;
  session.messages.push({ role: "user", content });

  try {
    if (!(await runTurn(session, chat, outbox))) {
      session.messages.length = checkpoint; // forget the refused exchange
      if (session === previous) return; // nothing new to save
    }
    session.updatedAt = Date.now();
    saveSession(chat.chatId, session);
  } catch (err) {
    console.error(`[${chat.chatName}] turn failed`, err);
    // The stored session is untouched, so the next message picks up from before this one.
    await outbox.sendText(chat.chatId, errorReply(err), chat.replyTo).catch(() => {});
  }
}
