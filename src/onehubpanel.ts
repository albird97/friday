import { randomInt } from "node:crypto";
import type { BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { z } from "zod";
import { config } from "./config.js";
import { api, onehubAllowed, onehubResiAllowed } from "./onehub.js";
import type { ChatContext, Outbox } from "./types.js";

// onehub's admin panel, driven from WhatsApp. onehub runs the panel's own pages, forms and buttons as the person's
// onehub user (their permissions, their name in the audit log), so everything the panel can do Friday can do, and
// nothing the person couldn't do in the panel themselves.
//
// Changes run at once, like onehub's other actions. Anything onehub marks destructive (deleting, cancelling,
// voiding, bulk changes, buttons that ask "are you sure?" in the panel) waits for the person to type the code Friday
// sends them. That code goes straight to WhatsApp and is checked here, before Claude sees the message: text in
// onehub's data or the conversation can't confirm anything on its own.

const CONFIRM_MINUTES = 10;

type RunInput = z.infer<typeof RunInput>;
type Preview = { summary: string; destructive: boolean; token: string };
type Pending = { code: string; input: RunInput; preview: Preview; number: string; expires: number };

const pending = new Map<string, Pending>();

const PagesInput = z.object({
  search: z.string().optional().describe("Optional word to filter pages by name or menu group, e.g. 'order' or 'keuangan'."),
});
const InspectInput = z.object({
  page: z.string().min(1).describe("Page id from onehub_panel_pages, e.g. 'orders', 'expenses/create', 'packing-station'."),
  record: z.string().optional().describe("Record key (id) for pages or row actions about one record, e.g. an order id."),
});
const ResiInput = z.object({
  order: z.string().min(1).max(64).describe("The marketplace order number (e.g. Shopee order SN) or the shipping tracking number."),
});
const RunInput = z.object({
  page: z.string().min(1).describe("Page id from onehub_panel_pages."),
  action: z
    .string()
    .min(1)
    .describe(
      "Action name from onehub_panel_inspect: a button/row/bulk action, 'create' / 'save' to submit a create or edit page's form, " +
        "or 'call' to run `steps` on a custom screen (packing, handover, chat, settings…).",
    ),
  record: z.string().optional().describe("Record key for the page (edit/view pages) or for a row action."),
  records: z.array(z.string()).optional().describe("Record keys for a bulk action."),
  data: z.record(z.string(), z.unknown()).optional().describe("Form fields by name, as listed by onehub_panel_inspect."),
  arguments: z.record(z.string(), z.unknown()).optional().describe("Action arguments, only when onehub_panel_inspect lists any."),
  steps: z
    .array(
      z.object({
        set: z.string().optional().describe("Property to set, e.g. 'data.store_name'."),
        value: z.unknown().optional(),
        call: z.string().optional().describe("Page method to call, as listed by onehub_panel_inspect."),
        params: z.array(z.unknown()).optional(),
      }),
    )
    .max(20)
    .optional()
    .describe("For action 'call': what a person would do on that screen, in order; each step is one click or one field change."),
});

const TOOLS = [
  {
    name: "onehub_panel_pages",
    description:
      "List the onehub admin panel pages this person may open (resources like orders, products, expenses, purchase orders, " +
      "returns, and tools like packing, picking, chat, reports). Use it to find the page for anything that changes data and " +
      "isn't covered by a dedicated onehub_* action.",
    schema: PagesInput,
  },
  {
    name: "onehub_panel_inspect",
    description:
      "Show what can be done on one onehub panel page, as this person: its buttons, row actions and bulk actions, and the " +
      "form fields (names, types, options, required) each one or the page's own form takes. Pass `record` to see a single " +
      "record's page or row actions. Call it before onehub_panel_run so the action and field names are exact.",
    schema: InspectInput,
  },
  {
    name: "onehub_panel_run",
    description:
      "Do something in onehub's panel exactly as the person would by clicking: submit a create/edit form, press a button, " +
      "run a row or bulk action (including delete). onehub checks this person's permissions and validates the form like the " +
      "panel does. Ordinary changes run at once and the person is sent onehub's summary. Destructive ones (delete, cancel, " +
      "void, bulk, anything the panel asks to confirm) only run after the person types the code Friday sends them, so " +
      "don't ask them to confirm yourself. Only use it for what this person asked for in their own message, one at a time.",
    schema: RunInput,
  },
  {
    name: "onehub_resi",
    description:
      "Send this person the shipping label (resi) PDF of one Shopee or TikTok/Tokopedia order as a WhatsApp document, " +
      "made the same way as the panel's Cetak Resi button. Pass the order number or the tracking number. If the label " +
      "doesn't exist yet onehub creates the shipping document at the marketplace, like that button does.",
    schema: ResiInput,
  },
];

function jsonSchema(schema: z.ZodObject) {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return json as { type: "object"; [key: string]: unknown };
}

export function panelTools(chat: ChatContext): BetaToolUnion[] {
  if (!config.ONEHUB_API_URL) return [];
  const tools = onehubAllowed(chat) ? TOOLS : onehubResiAllowed(chat) ? TOOLS.filter((t) => t.name === "onehub_resi") : [];
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: jsonSchema(t.schema) }));
}

const requestedBy = (chat: ChatContext) => ({ name: chat.sender.name, number: chat.sender.number });

/** Runs an onehub_panel_* tool. Returns undefined if `name` isn't one. */
export async function runPanelTool(name: string, input: unknown, chat: ChatContext, outbox: Outbox): Promise<string | undefined> {
  if (!name.startsWith("onehub_panel_") && name !== "onehub_resi") return undefined;
  if (!(name === "onehub_resi" ? onehubResiAllowed(chat) : onehubAllowed(chat))) throw new Error("onehub isn't available in this chat.");
  if (name === "onehub_panel_pages") {
    const { search } = PagesInput.parse(input);
    return (await api<{ text: string }>("POST", "/panel/pages", { search: search ?? null, requested_by: requestedBy(chat) })).text;
  }
  if (name === "onehub_panel_inspect") {
    const body = InspectInput.parse(input);
    return (await api<{ text: string }>("POST", "/panel/inspect", { ...body, requested_by: requestedBy(chat) })).text;
  }
  if (name === "onehub_panel_run") return run(RunInput.parse(input), chat, outbox);
  if (name === "onehub_resi") return resi(ResiInput.parse(input), chat, outbox);
  throw new Error(`Unknown onehub panel tool ${name}.`);
}

async function run(input: RunInput, chat: ChatContext, outbox: Outbox): Promise<string> {
  const preview = await api<Preview>("POST", "/panel/preview", { ...input, requested_by: requestedBy(chat) });
  if (!preview.destructive) {
    const message = await execute(input, preview, chat);
    // Sent by code, not by Claude, so what the person reads is exactly what onehub did.
    await outbox.sendText(chat.chatId, `✅ ${message}\n\n${preview.summary}`);
    return `onehub did it: ${message}\nThey were sent that with onehub's summary, so don't repeat it; answer in one short line at most.`;
  }
  const code = String(randomInt(1000, 10_000));
  pending.set(chat.chatId, { code, input, preview, number: chat.sender.number, expires: Date.now() + CONFIRM_MINUTES * 60_000 });
  await outbox.sendText(
    chat.chatId,
    `⚠️ ${preview.summary}\n\nBalas *YA ${code}* dalam ${CONFIRM_MINUTES} menit untuk menjalankan. Abaikan pesan ini kalau tidak jadi.`,
  );
  return (
    "Nothing has run yet: this is destructive, so the person was sent onehub's summary and a code to type. When they reply " +
    "with it, Friday runs it and tells them the result. Don't repeat the summary or ask for the code; one short line at most."
  );
}

type Resi = { file_name: string; mimetype: string; caption: string; data: string };

/** The label goes only to the chat that asked: an onehub person's own chat, or a group in ONEHUB_RESI_GROUPS. */
async function resi({ order }: z.infer<typeof ResiInput>, chat: ChatContext, outbox: Outbox): Promise<string> {
  const file = await api<Resi>("POST", "/resi", { order, requested_by: requestedBy(chat) });
  const data = Buffer.from(file.data, "base64");
  await outbox.sendFile(chat.chatId, { data, fileName: file.file_name, mimetype: file.mimetype, caption: file.caption });
  return `Sent ${file.file_name} (${Math.ceil(data.length / 1024)} KB). Don't repeat it; one short line at most.`;
}

async function execute(input: RunInput, preview: Preview, chat: ChatContext): Promise<string> {
  try {
    const result = await api<{ message: string }>("POST", "/panel/execute", { ...input, token: preview.token, requested_by: requestedBy(chat) });
    return result.message;
  } catch (err) {
    throw new Error(`onehub didn't do it: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * "YA 1234" in reply to a destructive onehub change: runs it without Claude. Returns true when the message was that
 * reply (right or wrong code), so it isn't also sent to Claude.
 */
export async function confirmPanel(chat: ChatContext, text: string, outbox: Outbox): Promise<boolean> {
  const match = /^\s*(?:ya|yes|ok)\s+(\d{4})\s*$/i.exec(text);
  if (!match || chat.isGroup) return false;
  const wait = pending.get(chat.chatId);
  if (!wait || wait.number !== chat.sender.number || !onehubAllowed(chat)) return false;
  if (Date.now() > wait.expires) {
    pending.delete(chat.chatId);
    await outbox.sendText(chat.chatId, "Kodenya sudah kedaluwarsa, jadi tidak ada yang dijalankan. Minta ulang ke Friday kalau masih perlu.");
    return true;
  }
  if (match[1] !== wait.code) {
    await outbox.sendText(chat.chatId, "Kodenya tidak cocok, tidak ada yang dijalankan. Periksa lagi pesan konfirmasinya.");
    return true;
  }
  pending.delete(chat.chatId);
  try {
    const message = await execute(wait.input, wait.preview, chat);
    await outbox.sendText(chat.chatId, `✅ ${message}`);
  } catch (err) {
    await outbox.sendText(chat.chatId, `❌ ${err instanceof Error ? err.message : String(err)}`);
  }
  return true;
}

/** For tests. */
export function clearPanelConfirmations(): void {
  pending.clear();
}
