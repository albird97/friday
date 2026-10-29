import type { BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { z } from "zod";
import { findContact } from "./contacts.js";
import { markdownToDocx } from "./docs/docx.js";
import { markdownToPdf } from "./docs/pdf.js";
import { sheetsToXlsx, sheetToCsv } from "./docs/sheets.js";
import { slidesToPptx } from "./docs/slides.js";
import { imagesEnabled, loadImage, makeImage, saveImage, type ImageResult } from "./images.js";
import { errandTools, runErrandTool } from "./errands.js";
import { addMemory, forgetMemory, SHARED } from "./memory.js";
import { onehubTools, runOnehubTool } from "./onehub.js";
import { cancelReminder, createReminder, describeReminder, listReminders } from "./reminders.js";
import { formatDateTime } from "./time.js";
import type { ChatContext, Outbox, OutgoingFile } from "./types.js";

export type ToolContext = { chat: ChatContext; outbox: Outbox };

type Tool<S extends z.ZodObject = z.ZodObject> = {
  name: string;
  description: string;
  schema: S;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<string>;
};

const tool = <S extends z.ZodObject>(t: Tool<S>) => t as unknown as Tool;

function requireContact(ctx: ToolContext, action: string): void {
  if (!ctx.chat.sender.isContact) throw new Error(`Only known contacts can ${action}.`);
}

/** Resolves `send_to` / `for_contact` to a chat id; defaults to the current chat. */
function destination(ctx: ToolContext, contactName: string | undefined, action: string): { chatId: string; label: string } {
  if (!contactName) return { chatId: ctx.chat.chatId, label: "this chat" };
  requireContact(ctx, action);
  const contact = findContact(contactName);
  if (!contact) throw new Error(`"${contactName}" isn't a known contact.`);
  return { chatId: ctx.outbox.chatIdFor(contact.number), label: contact.name };
}

async function deliver(ctx: ToolContext, sendTo: string | undefined, file: OutgoingFile): Promise<string> {
  const to = destination(ctx, sendTo, "send files to other people");
  await ctx.outbox.sendFile(to.chatId, file);
  return `Sent ${file.fileName} (${Math.ceil(file.data.length / 1024)} KB) to ${to.label}. Don't repeat its contents in your reply.`;
}

function fileName(name: string | undefined, title: string, ext: string): string {
  const base = (name ?? title).replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[^\p{L}\p{N} _.-]+/gu, "").trim().slice(0, 80);
  return `${base || "document"}.${ext}`;
}

const sendTo = z
  .string()
  .optional()
  .describe("Name of a known contact to send the file to privately. Omit to send it to the current chat.");

const MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  md: "text/markdown",
  txt: "text/plain",
} as const;

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const aspectRatio = z
  .enum(["1:1", "3:4", "4:3", "9:16", "16:9"])
  .optional()
  .describe("Shape of the result. Defaults to square for new images, and the original's shape for edits.");

async function sendMadeImage(ctx: ToolContext, sendTo: string | undefined, image: ImageResult, caption?: string): Promise<string> {
  const to = destination(ctx, sendTo, "send images to other people");
  const id = saveImage(ctx.chat.chatId, image.mimetype, image.data);
  await ctx.outbox.sendImage(to.chatId, { ...image, caption });
  return `Sent image #${id} to ${to.label}. It's already delivered, so reply with one short line at most.`;
}

const IMAGE_TOOLS: Tool[] = [
  tool({
    name: "generate_image",
    description:
      "Create a new picture and send it in the chat: illustrations, realistic photos, posters, invitations, stickers, " +
      "logos, wallpapers. Write the prompt in English and make it vivid and specific: subject, setting, style, " +
      "lighting, composition, colours, and any text that should appear (in quotes).",
    schema: z.object({
      prompt: z.string().min(3),
      aspect_ratio: aspectRatio,
      caption: z.string().optional(),
      send_to: sendTo,
    }),
    async run(input, ctx) {
      return sendMadeImage(ctx, input.send_to, await makeImage({ prompt: input.prompt, aspectRatio: input.aspect_ratio }), input.caption);
    },
  }),
  tool({
    name: "edit_image",
    description:
      "Change an existing picture — a photo someone sent or one you made — referenced by its number (messages show " +
      "photos as \"image #12\"). Write the instruction in English: what to change and what must stay the same " +
      "(faces, pose, background…). Give up to 4 images to combine them, and refer to them as image 0, image 1… in the " +
      "order listed (e.g. \"put the person from image 0 into the beach scene from image 1\").",
    schema: z.object({
      image_ids: z.array(z.number().int()).min(1).max(4),
      instruction: z.string().min(3),
      aspect_ratio: aspectRatio,
      caption: z.string().optional(),
      send_to: sendTo,
    }),
    async run(input, ctx) {
      const inputs = input.image_ids.map((id) => {
        const img = loadImage(id, ctx.chat.chatId);
        if (!img) throw new Error(`Image #${id} isn't available in this chat (images are kept for 30 days). Ask them to send it again.`);
        return img;
      });
      const result = await makeImage({ prompt: input.instruction, inputs, aspectRatio: input.aspect_ratio });
      return sendMadeImage(ctx, input.send_to, result, input.caption);
    },
  }),
];

const BASE_TOOLS: Tool[] = [
  tool({
    name: "create_reminder",
    description:
      "Schedule a WhatsApp reminder. Give `when` for a one-off reminder, or `repeat_cron` for a repeating one. " +
      "All times are in the user's local timezone (shown in each message's timestamp). " +
      "Reminders go to the current chat unless `for_contact` names someone else.",
    schema: z.object({
      text: z.string().min(1).describe("What to remind about, phrased as the reminder message itself."),
      when: z.string().optional().describe('Local date-time for a one-off reminder, ISO format, e.g. "2026-10-29T17:00".'),
      repeat_cron: z
        .string()
        .optional()
        .describe('5-field cron in local time for repeating reminders, e.g. "0 8 * * 1-5" = weekdays 08:00.'),
      for_contact: z.string().optional().describe("Name of a known contact to remind in their private chat."),
    }),
    async run(input, ctx) {
      const to = destination(ctx, input.for_contact, "set reminders for other people");
      const text = input.for_contact ? `${input.text} (from ${ctx.chat.sender.name})` : input.text;
      const r = createReminder({ chatId: to.chatId, createdBy: ctx.chat.sender.number, text, when: input.when, cron: input.repeat_cron });
      return `Created reminder ${describeReminder(r)}, delivered to ${to.label}.`;
    },
  }),
  tool({
    name: "list_reminders",
    description: "List upcoming reminders for this chat and those the current person created.",
    schema: z.object({}),
    async run(_input, ctx) {
      const chats = [ctx.chat.chatId, ctx.outbox.chatIdFor(ctx.chat.sender.number)];
      const list = listReminders(chats, ctx.chat.sender.number);
      return list.length ? list.map(describeReminder).join("\n") : "No upcoming reminders.";
    },
  }),
  tool({
    name: "cancel_reminder",
    description: "Cancel a reminder by its #id (get ids from list_reminders).",
    schema: z.object({ id: z.number().int() }),
    async run({ id }, ctx) {
      const chats = [ctx.chat.chatId, ctx.outbox.chatIdFor(ctx.chat.sender.number)];
      return cancelReminder(id, chats, ctx.chat.sender.number) ? `Cancelled reminder #${id}.` : `No active reminder #${id} that this person can cancel.`;
    },
  }),
  tool({
    name: "remember",
    description:
      "Save a lasting fact or preference so you know it in future conversations (birthdays, preferences, " +
      "names, recurring plans). Only save what the person asks you to remember or would clearly want kept. " +
      'scope "private" = only this chat (this person, or this group); "shared" = everywhere you talk, groups included ' +
      "(so never shared for anything sensitive).",
    schema: z.object({
      fact: z.string().min(3),
      scope: z.enum(["private", "shared"]).default("private"),
    }),
    async run({ fact, scope }, ctx) {
      requireContact(ctx, "save memories");
      const owner = scope === "shared" ? SHARED : ctx.chat.isGroup ? ctx.chat.chatId : ctx.chat.sender.number;
      const id = addMemory(owner, fact);
      return `Saved memory #${id} (${scope}).`;
    },
  }),
  tool({
    name: "forget",
    description: "Delete a saved memory by its #id.",
    schema: z.object({ id: z.number().int() }),
    async run({ id }, ctx) {
      requireContact(ctx, "delete memories");
      const owners = [SHARED, ctx.chat.isGroup ? ctx.chat.chatId : ctx.chat.sender.number];
      return forgetMemory(id, owners) ? `Forgot memory #${id}.` : `No memory #${id} in this chat's scope.`;
    },
  }),
  tool({
    name: "create_document",
    description:
      "Create a document (PDF, Word, Markdown or plain text) from Markdown and send it as a WhatsApp file. " +
      "Use for letters, reports, summaries, itineraries, CVs, notes. Markdown supports headings, lists, tables, " +
      "bold/italic, links, quotes and code blocks. Don't repeat the title as a heading in `content`.",
    schema: z.object({
      format: z.enum(["pdf", "docx", "md", "txt"]),
      title: z.string().min(1),
      content: z.string().min(1).describe("The body in Markdown."),
      file_name: z.string().optional().describe("File name without extension; defaults to the title."),
      caption: z.string().optional().describe("Short WhatsApp caption shown with the file."),
      send_to: sendTo,
    }),
    async run(input, ctx) {
      const data =
        input.format === "pdf"
          ? await markdownToPdf(input.title, input.content)
          : input.format === "docx"
            ? await markdownToDocx(input.title, input.content)
            : Buffer.from(input.format === "md" ? `# ${input.title}\n\n${input.content}\n` : `${input.title}\n\n${input.content}\n`);
      return deliver(ctx, input.send_to, {
        data,
        fileName: fileName(input.file_name, input.title, input.format),
        mimetype: MIME[input.format],
        caption: input.caption,
      });
    },
  }),
  tool({
    name: "create_spreadsheet",
    description:
      "Create an Excel (.xlsx) or CSV file and send it as a WhatsApp file. The first row of each sheet is the header. " +
      'Use numbers for numeric cells; strings starting with "=" are Excel formulas (e.g. "=SUM(B2:B10)"). CSV uses the first sheet only.',
    schema: z.object({
      format: z.enum(["xlsx", "csv"]),
      file_name: z.string().min(1),
      sheets: z.array(z.object({ name: z.string(), rows: z.array(z.array(cell)) })).min(1),
      caption: z.string().optional(),
      send_to: sendTo,
    }),
    async run(input, ctx) {
      const data = input.format === "xlsx" ? await sheetsToXlsx(input.sheets) : sheetToCsv(input.sheets[0]);
      return deliver(ctx, input.send_to, {
        data,
        fileName: fileName(input.file_name, "spreadsheet", input.format),
        mimetype: MIME[input.format],
        caption: input.caption,
      });
    },
  }),
  tool({
    name: "create_presentation",
    description:
      "Create a PowerPoint (.pptx) deck and send it as a WhatsApp file. A title slide is added automatically. " +
      "Keep bullets short (under ~12 words, 3-6 per slide). A slide may have a small table (first row = header).",
    schema: z.object({
      title: z.string().min(1),
      subtitle: z.string().optional(),
      slides: z
        .array(
          z.object({
            title: z.string(),
            bullets: z.array(z.string()).optional(),
            table: z.array(z.array(z.string())).optional(),
            notes: z.string().optional().describe("Speaker notes."),
          }),
        )
        .min(1),
      file_name: z.string().optional(),
      caption: z.string().optional(),
      send_to: sendTo,
    }),
    async run(input, ctx) {
      return deliver(ctx, input.send_to, {
        data: await slidesToPptx(input.title, input.subtitle, input.slides),
        fileName: fileName(input.file_name, input.title, "pptx"),
        mimetype: MIME.pptx,
        caption: input.caption,
      });
    },
  }),
  tool({
    name: "send_message",
    description:
      "Send a WhatsApp message to a known contact's private chat on the current person's behalf " +
      "(e.g. \"tell my wife I'll be late\"). The message is labelled as coming from the current person.",
    schema: z.object({
      to: z.string().describe("The contact's name."),
      text: z.string().min(1),
    }),
    async run({ to, text }, ctx) {
      const target = destination(ctx, to, "send messages to other people");
      if (target.chatId === ctx.chat.chatId) return "That's this chat; just reply normally.";
      await ctx.outbox.sendText(target.chatId, `📨 *From ${ctx.chat.sender.name}:*\n${text}`);
      return `Sent to ${target.label} at ${formatDateTime(new Date())}.`;
    },
  }),
];

export const TOOLS: Tool[] = [...BASE_TOOLS, ...(imagesEnabled ? IMAGE_TOOLS : [])];

function inputSchema(schema: z.ZodObject) {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return json as { type: "object"; [key: string]: unknown };
}

/**
 * Tool definitions sent to Claude: ours plus Anthropic's server-side web search and fetch. The cache breakpoint on
 * the last one caches all tool definitions for an hour, shared by every chat (they're identical everywhere).
 */
export const toolParams: BetaToolUnion[] = [
  ...TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: inputSchema(t.schema),
    eager_input_streaming: true,
  })),
  { type: "web_search_20260209", name: "web_search", max_uses: 5 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 5, cache_control: { type: "ephemeral", ttl: "1h" } },
];

/**
 * The tools offered in a chat: the shared ones, plus errands and onehub for the people allowed to use them. Those
 * come after the shared, cached definitions so every chat still shares that cache.
 */
export async function toolsFor(chat: ChatContext): Promise<BetaToolUnion[]> {
  const extra = [...errandTools(chat), ...(await onehubTools(chat))];
  return extra.length ? [...toolParams, ...extra] : toolParams;
}

export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<{ content: string; isError: boolean }> {
  const t = TOOLS.find((candidate) => candidate.name === name);
  try {
    if (!t) {
      const content = (await runErrandTool(name, input, ctx.chat, ctx.outbox)) ?? (await runOnehubTool(name, input, ctx.chat, ctx.outbox));
      return content === undefined ? { content: `Unknown tool ${name}.`, isError: true } : { content, isError: false };
    }
    const parsed = t.schema.safeParse(input);
    if (!parsed.success) return { content: `Invalid input: ${z.prettifyError(parsed.error)}`, isError: true };
    return { content: await t.run(parsed.data, ctx), isError: false };
  } catch (err) {
    if (err instanceof z.ZodError) return { content: `Invalid input: ${z.prettifyError(err)}`, isError: true };
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}

