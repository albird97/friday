import { randomBytes, randomInt } from "node:crypto";
import type { BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { z } from "zod";
import { config } from "./config.js";
import { db } from "./db.js";
import { google, googleAccount, googleAllowed, SCOPES, type Scope } from "./google.js";
import { loadImage } from "./images.js";
import type { ChatContext, Outbox } from "./types.js";

// What Friday can do in someone's own Google apps. Reading runs straight away. A tool with a `preview` changes
// something, so it only proposes: the person gets a preview built here from the real input (not Claude's words) and
// must answer with a one-time code, which this file checks. Mail and files can carry hidden instructions, and this
// keeps them from sending or changing anything on their own.

const CONFIRM_MINUTES = 10;
const CONFIRM = /^\s*(?:ya|yes)\s+(\d{4})\s*[.!]?\s*$/i;
const MAX_CHARS = 20_000;

const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const TASKS = "https://tasks.googleapis.com/tasks/v1/lists/@default/tasks";
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const DOCS = "https://docs.googleapis.com/v1/documents";
const SLIDES = "https://slides.googleapis.com/v1/presentations";
const FORMS = "https://forms.googleapis.com/v1/forms";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const PEOPLE = "https://people.googleapis.com/v1";
const YOUTUBE = "https://www.googleapis.com/youtube/v3";

type Context = { number: string; chatId: string };

type App<S extends z.ZodObject = z.ZodObject> = {
  name: string;
  description: string;
  scope: Scope;
  schema: S;
  /** Present on tools that change something. The lines shown to the person before they confirm. */
  preview?: (input: z.infer<S>) => string;
  run: (input: z.infer<S>, ctx: Context) => Promise<string>;
};
const app = <S extends z.ZodObject>(t: App<S>) => t as unknown as App;

const clip = (text: string) => (text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[…cut, ${text.length} characters in all]` : text);
const line = (text: string) => text.replace(/[\r\n]+/g, " ").trim();
const list = (rows: string[], none: string) => (rows.length ? clip(rows.join("\n")) : none);
const base64url = (text: string | Buffer) => Buffer.from(text).toString("base64url");

// --- Calendar ------------------------------------------------------------------------------------------------------

type Event = { id: string; summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; location?: string; hangoutLink?: string; htmlLink?: string };
const describeEvent = (e: Event) =>
  `- ${e.id}: ${e.summary ?? "(no title)"} | ${e.start?.dateTime ?? e.start?.date} to ${e.end?.dateTime ?? e.end?.date}${e.location ? ` | ${e.location}` : ""}${e.hangoutLink ? ` | ${e.hangoutLink}` : ""}`;
const when = (value: string) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? { date: value } : { dateTime: value, timeZone: config.TIMEZONE });

const eventFields = {
  title: z.string().min(1),
  start: z.string().describe('Local "2026-11-03T10:00:00", or "2026-11-03" for all day.'),
  end: z.string().describe('Same format as start. For all day, the day after the last one.'),
  location: z.string().optional(),
  description: z.string().optional(),
  attendees: z.array(z.email()).optional().describe("Google emails them an invitation."),
};
const eventBody = (i: { title?: string; start?: string; end?: string; location?: string; description?: string; attendees?: string[] }) => ({
  ...(i.title !== undefined && { summary: i.title }),
  ...(i.start !== undefined && { start: when(i.start) }),
  ...(i.end !== undefined && { end: when(i.end) }),
  ...(i.location !== undefined && { location: i.location }),
  ...(i.description !== undefined && { description: i.description }),
  ...(i.attendees && { attendees: i.attendees.map((email) => ({ email })) }),
});

const CALENDAR_TOOLS = [
  app({
    name: "google_calendar_events",
    description: "List events on this person's own calendar, optionally matching words. Defaults to the next 7 days.",
    scope: SCOPES.calendar,
    schema: z.object({
      from: z.string().optional().describe('RFC 3339 with offset, e.g. "2026-11-03T00:00:00+07:00". Default: now.'),
      to: z.string().optional().describe("Same format. Default: 7 days after `from`."),
      search: z.string().optional(),
    }),
    async run({ from, to, search }, { number }) {
      const start = from ? new Date(from) : new Date();
      const end = to ?? new Date(start.getTime() + 7 * 86_400_000).toISOString();
      const { items = [] } = await google<{ items?: Event[] }>(number, CALENDAR, {
        query: { timeMin: start.toISOString(), timeMax: new Date(end).toISOString(), q: search, singleEvents: true, orderBy: "startTime", maxResults: 50 },
      });
      return list(items.map(describeEvent), "No events in that period.");
    },
  }),
  app({
    name: "google_calendar_add",
    description: "Propose a new event on this person's calendar, with an optional Google Meet link.",
    scope: SCOPES.calendar,
    schema: z.object({ ...eventFields, meet: z.boolean().optional().describe("Add a Google Meet link.") }),
    preview: (i) => [`Tambah acara: *${line(i.title)}*`, `${i.start} s/d ${i.end}`, i.location && `Lokasi: ${line(i.location)}`, i.attendees?.length && `Undang: ${i.attendees.join(", ")}`, i.meet && "Dengan link Google Meet"].filter(Boolean).join("\n"),
    async run(i, { number }) {
      const conference = i.meet ? { conferenceData: { createRequest: { requestId: randomBytes(8).toString("hex"), conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {};
      const event = await google<Event>(number, CALENDAR, {
        method: "POST",
        query: { conferenceDataVersion: i.meet ? 1 : undefined, sendUpdates: i.attendees?.length ? "all" : undefined },
        json: { ...eventBody(i), ...conference },
      });
      return `Acara dibuat: ${event.summary}${event.hangoutLink ? `\nMeet: ${event.hangoutLink}` : ""}`;
    },
  }),
  app({
    name: "google_calendar_change",
    description: "Propose changing an event (get its id from google_calendar_events). Only pass what changes.",
    scope: SCOPES.calendar,
    schema: z.object({ event_id: z.string(), ...z.object(eventFields).partial().shape }),
    preview: (i) => [`Ubah acara ${i.event_id}`, i.title && `Judul: ${line(i.title)}`, i.start && `Mulai: ${i.start}`, i.end && `Selesai: ${i.end}`, i.location && `Lokasi: ${line(i.location)}`, i.attendees?.length && `Undang: ${i.attendees.join(", ")}`].filter(Boolean).join("\n"),
    async run({ event_id, ...i }, { number }) {
      const event = await google<Event>(number, `${CALENDAR}/${encodeURIComponent(event_id)}`, { method: "PATCH", query: { sendUpdates: i.attendees?.length ? "all" : undefined }, json: eventBody(i) });
      return `Acara diubah: ${event.summary}`;
    },
  }),
  app({
    name: "google_calendar_delete",
    description: "Propose deleting an event.",
    scope: SCOPES.calendar,
    schema: z.object({ event_id: z.string(), title: z.string().describe("The event's title, shown to the person.") }),
    preview: (i) => `Hapus acara: *${line(i.title)}* (${i.event_id})`,
    async run({ event_id, title }, { number }) {
      await google(number, `${CALENDAR}/${encodeURIComponent(event_id)}`, { method: "DELETE" });
      return `Acara dihapus: ${title}`;
    },
  }),
];

// --- Tasks ---------------------------------------------------------------------------------------------------------

const TASK_TOOLS = [
  app({
    name: "google_tasks_list",
    description: "List this person's open Google Tasks.",
    scope: SCOPES.tasks,
    schema: z.object({}),
    async run(_i, { number }) {
      const { items = [] } = await google<{ items?: { id: string; title: string; due?: string; notes?: string }[] }>(number, TASKS, { query: { showCompleted: false, maxResults: 100 } });
      return list(items.map((t) => `- ${t.id}: ${t.title}${t.due ? ` (due ${t.due.slice(0, 10)})` : ""}${t.notes ? ` | ${t.notes}` : ""}`), "No open tasks.");
    },
  }),
  app({
    name: "google_tasks_add",
    description: "Propose adding a task.",
    scope: SCOPES.tasks,
    schema: z.object({ title: z.string().min(1), notes: z.string().optional(), due: z.string().optional().describe('A date, "2026-11-03".') }),
    preview: (i) => [`Tambah tugas: *${line(i.title)}*`, i.due && `Tenggat: ${i.due}`].filter(Boolean).join("\n"),
    async run({ title, notes, due }, { number }) {
      await google(number, TASKS, { method: "POST", json: { title, notes, due: due && `${due}T00:00:00.000Z` } });
      return `Tugas ditambahkan: ${title}`;
    },
  }),
  app({
    name: "google_tasks_done",
    description: "Propose marking a task as done.",
    scope: SCOPES.tasks,
    schema: z.object({ task_id: z.string(), title: z.string() }),
    preview: (i) => `Tandai selesai: *${line(i.title)}*`,
    async run({ task_id, title }, { number }) {
      await google(number, `${TASKS}/${encodeURIComponent(task_id)}`, { method: "PATCH", json: { status: "completed" } });
      return `Tugas selesai: ${title}`;
    },
  }),
];

// --- Contacts ------------------------------------------------------------------------------------------------------

const CONTACT_TOOLS = [
  app({
    name: "google_contacts_search",
    description: "Find people in this person's Google Contacts, e.g. for an email address.",
    scope: SCOPES.contacts,
    schema: z.object({ query: z.string().min(1) }),
    async run({ query }, { number }) {
      const { results = [] } = await google<{ results?: { person: { names?: { displayName: string }[]; emailAddresses?: { value: string }[]; phoneNumbers?: { value: string }[] } }[] }>(
        number,
        `${PEOPLE}/people:searchContacts`,
        { query: { query, readMask: "names,emailAddresses,phoneNumbers", pageSize: 10 } },
      );
      return list(
        results.map(({ person: p }) => `- ${p.names?.[0]?.displayName ?? "(no name)"} | ${p.emailAddresses?.map((e) => e.value).join(", ") ?? ""} | ${p.phoneNumbers?.map((n) => n.value).join(", ") ?? ""}`),
        "No matching contacts.",
      );
    },
  }),
];

// --- Drive, Docs, Sheets, Slides -----------------------------------------------------------------------------------

const EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

async function upload(number: string, metadata: Record<string, unknown>, data: Buffer | string, mimetype: string): Promise<{ id: string; webViewLink?: string; name?: string }> {
  const boundary = `friday${randomBytes(8).toString("hex")}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimetype}\r\n\r\n`),
    Buffer.from(data),
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  return google(number, UPLOAD, { method: "POST", query: { uploadType: "multipart", fields: "id,name,webViewLink" }, body, contentType: `multipart/related; boundary=${boundary}` });
}

const DRIVE_TOOLS = [
  app({
    name: "google_drive_search",
    description: "Find files in this person's Google Drive, including Docs, Sheets and Slides, by words in the name or content.",
    scope: SCOPES.driveRead,
    schema: z.object({ words: z.string().min(1) }),
    async run({ words }, { number }) {
      const { files = [] } = await google<{ files?: { id: string; name: string; mimeType: string; modifiedTime: string; webViewLink?: string }[] }>(number, DRIVE, {
        query: { q: `fullText contains '${words.replace(/['\\]/g, "\\$&")}' and trashed = false`, pageSize: 15, fields: "files(id,name,mimeType,modifiedTime,webViewLink)" },
      });
      return list(files.map((f) => `- ${f.id}: ${f.name} (${f.mimeType}, ${f.modifiedTime.slice(0, 10)}) ${f.webViewLink ?? ""}`), "No matching files.");
    },
  }),
  app({
    name: "google_drive_read",
    description: "Read a Drive file as text: Docs, Slides, Sheets (first sheet, as CSV), or plain text files. PDFs and images can't be read this way; ask the person to send them in the chat.",
    scope: SCOPES.driveRead,
    schema: z.object({ file_id: z.string() }),
    async run({ file_id }, { number }) {
      const url = `${DRIVE}/${encodeURIComponent(file_id)}`;
      const file = await google<{ name: string; mimeType: string }>(number, url, { query: { fields: "name,mimeType" } });
      const type = EXPORTS[file.mimeType];
      if (type) return clip(await google<string>(number, `${url}/export`, { query: { mimeType: type }, text: true }));
      if (/^text\/|json|xml|csv/.test(file.mimeType)) return clip(await google<string>(number, url, { query: { alt: "media" }, text: true }));
      return `${file.name} is ${file.mimeType}, which can't be read as text here.`;
    },
  }),
  app({
    name: "google_drive_save_photo",
    description: 'Propose saving a photo from this chat to Drive, using its image number (photos appear as "[image #12]").',
    scope: SCOPES.driveFile,
    schema: z.object({ image_number: z.number().int(), file_name: z.string().min(1) }),
    preview: (i) => `Simpan foto #${i.image_number} ke Drive sebagai *${line(i.file_name)}*`,
    async run({ image_number, file_name }, { number, chatId }) {
      const image = loadImage(image_number, chatId);
      if (!image) throw new Error(`No image #${image_number} in this chat (old ones get removed).`);
      const file = await upload(number, { name: file_name }, image.data, image.mimetype);
      return `Foto tersimpan di Drive: ${file.webViewLink ?? file_name}`;
    },
  }),
  app({
    name: "google_docs_create",
    description: "Propose creating a Google Doc from plain text.",
    scope: SCOPES.driveFile,
    schema: z.object({ title: z.string().min(1), text: z.string().min(1) }),
    preview: (i) => `Buat Google Doc: *${line(i.title)}*\n${i.text.length} karakter`,
    async run({ title, text }, { number }) {
      const file = await upload(number, { name: title, mimeType: "application/vnd.google-apps.document" }, text, "text/plain; charset=UTF-8");
      return `Google Doc dibuat: ${file.webViewLink ?? title}`;
    },
  }),
  app({
    name: "google_docs_append",
    description: "Propose adding text to the end of an existing Google Doc.",
    scope: SCOPES.docs,
    schema: z.object({ document_id: z.string(), document_name: z.string(), text: z.string().min(1) }),
    preview: (i) => `Tambah teks ke *${line(i.document_name)}*:\n${i.text.slice(0, 300)}`,
    async run({ document_id, document_name, text }, { number }) {
      const url = `${DOCS}/${encodeURIComponent(document_id)}`;
      const doc = await google<{ body: { content: { endIndex?: number }[] } }>(number, url, { query: { fields: "body(content(endIndex))" } });
      const index = (doc.body.content.at(-1)?.endIndex ?? 2) - 1;
      await google(number, `${url}:batchUpdate`, { method: "POST", json: { requests: [{ insertText: { location: { index }, text: `\n${text}` } }] } });
      return `Teks ditambahkan ke ${document_name}.`;
    },
  }),
  app({
    name: "google_sheets_create",
    description: "Propose creating a Google Sheet with rows of values. The first row is usually headers.",
    scope: SCOPES.sheets,
    schema: z.object({ title: z.string().min(1), rows: z.array(z.array(z.union([z.string(), z.number()]))).min(1) }),
    preview: (i) => `Buat Google Sheet: *${line(i.title)}*\n${i.rows.length} baris`,
    async run({ title, rows }, { number }) {
      const sheet = await google<{ spreadsheetId: string; spreadsheetUrl: string; sheets: { properties: { title: string } }[] }>(number, SHEETS, { method: "POST", json: { properties: { title } } });
      const range = encodeURIComponent(sheet.sheets[0].properties.title);
      await google(number, `${SHEETS}/${sheet.spreadsheetId}/values/${range}`, { method: "PUT", query: { valueInputOption: "RAW" }, json: { values: rows } });
      return `Google Sheet dibuat: ${sheet.spreadsheetUrl}`;
    },
  }),
  app({
    name: "google_sheets_read",
    description: "Read cells from a Google Sheet.",
    scope: SCOPES.sheets,
    schema: z.object({ spreadsheet_id: z.string(), range: z.string().describe('e.g. "Sheet1!A1:D50".') }),
    async run({ spreadsheet_id, range }, { number }) {
      const { values = [] } = await google<{ values?: unknown[][] }>(number, `${SHEETS}/${encodeURIComponent(spreadsheet_id)}/values/${encodeURIComponent(range)}`);
      return list(values.map((row) => row.join(" | ")), "That range is empty.");
    },
  }),
  app({
    name: "google_sheets_add_rows",
    description: "Propose adding rows after the last row of a Google Sheet.",
    scope: SCOPES.sheets,
    schema: z.object({ spreadsheet_id: z.string(), sheet_name: z.string().describe("The tab, e.g. Sheet1."), rows: z.array(z.array(z.union([z.string(), z.number()]))).min(1) }),
    preview: (i) => `Tambah ${i.rows.length} baris ke *${line(i.sheet_name)}*:\n${i.rows.slice(0, 5).map((r) => r.join(" | ")).join("\n")}`,
    async run({ spreadsheet_id, sheet_name, rows }, { number }) {
      await google(number, `${SHEETS}/${encodeURIComponent(spreadsheet_id)}/values/${encodeURIComponent(sheet_name)}:append`, { method: "POST", query: { valueInputOption: "RAW" }, json: { values: rows } });
      return `${rows.length} baris ditambahkan ke ${sheet_name}.`;
    },
  }),
  app({
    name: "google_slides_create",
    description: "Propose creating a Google Slides deck: each slide has a title and body text.",
    scope: SCOPES.slides,
    schema: z.object({ title: z.string().min(1), slides: z.array(z.object({ title: z.string(), body: z.string() })).min(1).max(30) }),
    preview: (i) => `Buat Google Slides: *${line(i.title)}*\n${i.slides.length} slide`,
    async run({ title, slides }, { number }) {
      const deck = await google<{ presentationId: string; slides: { objectId: string }[] }>(number, SLIDES, { method: "POST", json: { title } });
      const requests = slides.flatMap((slide, n) => [
        { createSlide: { objectId: `slide${n}`, slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" }, placeholderIdMappings: [{ layoutPlaceholder: { type: "TITLE" }, objectId: `title${n}` }, { layoutPlaceholder: { type: "BODY" }, objectId: `body${n}` }] } },
        { insertText: { objectId: `title${n}`, text: slide.title } },
        { insertText: { objectId: `body${n}`, text: slide.body } },
      ]);
      await google(number, `${SLIDES}/${deck.presentationId}:batchUpdate`, { method: "POST", json: { requests: [...requests, ...deck.slides.map((s) => ({ deleteObject: { objectId: s.objectId } }))] } });
      return `Google Slides dibuat: https://docs.google.com/presentation/d/${deck.presentationId}/edit`;
    },
  }),
];

// --- Forms ---------------------------------------------------------------------------------------------------------

const FORM_TOOLS = [
  app({
    name: "google_forms_create",
    description: "Propose creating a Google Form, for sign-ups or surveys. Returns the link to share.",
    scope: SCOPES.forms,
    schema: z.object({
      title: z.string().min(1),
      questions: z.array(z.object({ question: z.string().min(1), choices: z.array(z.string()).optional().describe("Multiple choice. Leave out for a free-text answer."), required: z.boolean().optional() })).min(1).max(50),
    }),
    preview: (i) => `Buat Google Form: *${line(i.title)}*\n${i.questions.map((q, n) => `${n + 1}. ${line(q.question)}`).join("\n")}`,
    async run({ title, questions }, { number }) {
      const form = await google<{ formId: string; responderUri: string }>(number, FORMS, { method: "POST", json: { info: { title } } });
      const requests = questions.map((q, index) => ({
        createItem: {
          location: { index },
          item: {
            title: q.question,
            questionItem: {
              question: { required: q.required ?? false, ...(q.choices?.length ? { choiceQuestion: { type: "RADIO", options: q.choices.map((value) => ({ value })) } } : { textQuestion: {} }) },
            },
          },
        },
      }));
      await google(number, `${FORMS}/${form.formId}:batchUpdate`, { method: "POST", json: { requests } });
      await google(number, `${FORMS}/${form.formId}:setPublishSettings`, { method: "POST", json: { publishSettings: { publishState: { isPublished: true, isAcceptingResponses: true } } } });
      return `Google Form dibuat (form id ${form.formId}): ${form.responderUri}`;
    },
  }),
  app({
    name: "google_forms_responses",
    description: "Read the answers to a Google Form.",
    scope: SCOPES.formResponses,
    schema: z.object({ form_id: z.string() }),
    async run({ form_id }, { number }) {
      const id = encodeURIComponent(form_id);
      const form = await google<{ items?: { title?: string; questionItem?: { question: { questionId: string } } }[] }>(number, `${FORMS}/${id}`);
      const titles = new Map(form.items?.map((i) => [i.questionItem?.question.questionId, i.title]));
      const { responses = [] } = await google<{ responses?: { lastSubmittedTime: string; answers?: Record<string, { textAnswers?: { answers?: { value: string }[] } }> }[] }>(number, `${FORMS}/${id}/responses`);
      const rows = responses.map((r) => {
        const answers = Object.entries(r.answers ?? {}).map(([q, a]) => `${titles.get(q) ?? q}: ${a.textAnswers?.answers?.map((v) => v.value).join(", ") ?? ""}`);
        return `- ${r.lastSubmittedTime.slice(0, 16)}: ${answers.join(" | ")}`;
      });
      return list(rows, "No responses yet.");
    },
  }),
];

// --- Gmail ---------------------------------------------------------------------------------------------------------

type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: { name: string; value: string }[] };
type Mail = { id: string; threadId: string; snippet?: string; payload?: Part };
const header = (mail: Mail, name: string) => mail.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

function mailText(part: Part | undefined, type: string): string | undefined {
  if (!part) return undefined;
  if (part.mimeType === type && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  for (const child of part.parts ?? []) {
    const text = mailText(child, type);
    if (text) return text;
  }
  return undefined;
}
const stripHtml = (html: string) => html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/** An RFC 2822 message, base64url encoded for Gmail. `line` keeps a crafted address or subject from adding headers. */
function rawMail(i: { to: string; subject: string; body: string }, extra: string[] = []): string {
  const subject = `=?UTF-8?B?${Buffer.from(line(i.subject)).toString("base64")}?=`;
  return base64url([`To: ${line(i.to)}`, `Subject: ${subject}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", ...extra, "", Buffer.from(i.body).toString("base64")].join("\r\n"));
}

async function replyHeaders(number: string, id: string | undefined): Promise<{ extra: string[]; threadId?: string }> {
  if (!id) return { extra: [] };
  const mail = await google<Mail>(number, `${GMAIL}/messages/${encodeURIComponent(id)}`, { query: { format: "metadata", metadataHeaders: "Message-ID" } });
  const messageId = line(header(mail, "Message-ID"));
  return { extra: [`In-Reply-To: ${messageId}`, `References: ${messageId}`], threadId: mail.threadId };
}

const mailFields = { to: z.email(), subject: z.string().min(1), body: z.string().min(1), reply_to_id: z.string().optional().describe("The message id, when this answers an email.") };
const mailPreview = (verb: string) => (i: { to: string; subject: string; body: string }) => `${verb} ke: *${line(i.to)}*\nSubjek: ${line(i.subject)}\n\n${i.body.slice(0, 700)}${i.body.length > 700 ? "…" : ""}`;

const GMAIL_TOOLS = [
  app({
    name: "google_gmail_search",
    description: 'Search this person\'s Gmail with Gmail search words, e.g. "is:unread newer_than:2d" or "from:bank tagihan". Gives ids, senders, subjects and snippets.',
    scope: SCOPES.gmailRead,
    schema: z.object({ query: z.string().min(1), max: z.number().int().min(1).max(20).optional() }),
    async run({ query, max }, { number }) {
      const { messages = [] } = await google<{ messages?: { id: string }[] }>(number, `${GMAIL}/messages`, { query: { q: query, maxResults: max ?? 10 } });
      const mails = await Promise.all(
        messages.map(async ({ id }) => {
          const mail = await google<Mail>(number, `${GMAIL}/messages/${id}`, { query: { format: "metadata", fields: "snippet,payload(headers)" } });
          return { id, from: header(mail, "From"), subject: header(mail, "Subject"), snippet: mail.snippet };
        }),
      );
      return list(mails.map((m) => `- ${m.id}: ${m.from} | ${m.subject} | ${m.snippet ?? ""}`), "No matching emails.");
    },
  }),
  app({
    name: "google_gmail_read",
    description: "Read one email in full.",
    scope: SCOPES.gmailRead,
    schema: z.object({ message_id: z.string() }),
    async run({ message_id }, { number }) {
      const mail = await google<Mail>(number, `${GMAIL}/messages/${encodeURIComponent(message_id)}`, { query: { format: "full" } });
      const html = mailText(mail.payload, "text/html");
      const body = mailText(mail.payload, "text/plain") ?? (html ? stripHtml(html) : mail.snippet ?? "");
      return clip(`From: ${header(mail, "From")}\nTo: ${header(mail, "To")}\nDate: ${header(mail, "Date")}\nSubject: ${header(mail, "Subject")}\n\n${body}`);
    },
  }),
  app({
    name: "google_gmail_draft",
    description: "Propose saving an email as a draft in Gmail, for the person to review and send themselves.",
    scope: SCOPES.gmailCompose,
    schema: z.object(mailFields),
    preview: mailPreview("Simpan draf email"),
    async run({ reply_to_id, ...mail }, { number }) {
      const { extra, threadId } = await replyHeaders(number, reply_to_id);
      await google(number, `${GMAIL}/drafts`, { method: "POST", json: { message: { raw: rawMail(mail, extra), threadId } } });
      return `Draf email ke ${mail.to} tersimpan di Gmail.`;
    },
  }),
  app({
    name: "google_gmail_send",
    description: "Propose sending an email from this person's Gmail, only when they asked to send it.",
    scope: SCOPES.gmailSend,
    schema: z.object(mailFields),
    preview: mailPreview("Kirim email"),
    async run({ reply_to_id, ...mail }, { number }) {
      const { extra, threadId } = await replyHeaders(number, reply_to_id);
      await google(number, `${GMAIL}/messages/send`, { method: "POST", json: { raw: rawMail(mail, extra), threadId } });
      return `Email terkirim ke ${mail.to}.`;
    },
  }),
];

// --- YouTube -------------------------------------------------------------------------------------------------------

const YOUTUBE_TOOLS = [
  app({
    name: "google_youtube_search",
    description: "Search YouTube videos. Gives titles, channels and links, not what's said in them. Uses a small daily quota, so prefer one search.",
    scope: SCOPES.youtube,
    schema: z.object({ query: z.string().min(1) }),
    async run({ query }, { number }) {
      const { items = [] } = await google<{ items?: { id: { videoId: string }; snippet: { title: string; channelTitle: string; publishedAt: string } }[] }>(number, `${YOUTUBE}/search`, { grant: "youtube", query: { part: "snippet", type: "video", q: query, maxResults: 5 } });
      return list(items.map((v) => `- ${v.snippet.title} | ${v.snippet.channelTitle} | ${v.snippet.publishedAt.slice(0, 10)} | https://youtu.be/${v.id.videoId}`), "No videos found.");
    },
  }),
  app({
    name: "google_youtube_subscriptions",
    description: "List the YouTube channels this person subscribes to.",
    scope: SCOPES.youtube,
    schema: z.object({}),
    async run(_i, { number }) {
      const { items = [] } = await google<{ items?: { snippet: { title: string } }[] }>(number, `${YOUTUBE}/subscriptions`, { grant: "youtube", query: { part: "snippet", mine: true, maxResults: 50 } });
      return list(items.map((c) => `- ${c.snippet.title}`), "No subscriptions.");
    },
  }),
];

const APPS = [...CALENDAR_TOOLS, ...TASK_TOOLS, ...CONTACT_TOOLS, ...DRIVE_TOOLS, ...FORM_TOOLS, ...GMAIL_TOOLS, ...YOUTUBE_TOOLS];

function jsonSchema(schema: z.ZodObject) {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return json as { type: "object"; [key: string]: unknown };
}

/** The tools for this chat: only in private, only once connected, and only for what the person allowed on Google's screen. */
export function googleTools(chat: ChatContext): BetaToolUnion[] {
  if (!googleAllowed(chat)) return [];
  const account = googleAccount(chat.sender.number);
  if (!account) return [];
  return APPS.filter((t) => account.scopes.includes(t.scope)).map((t) => ({ name: t.name, description: t.description, input_schema: jsonSchema(t.schema), eager_input_streaming: true }));
}

/** Runs a google_* tool. Returns undefined if `name` isn't one. */
export async function runGoogleTool(name: string, input: unknown, chat: ChatContext, outbox: Outbox): Promise<string | undefined> {
  if (!name.startsWith("google_")) return undefined;
  if (!googleAllowed(chat)) throw new Error("Google isn't available in this chat. It works in the person's private chat.");
  const tool = APPS.find((t) => t.name === name);
  if (!tool) throw new Error(`No Google tool called ${name}.`);
  const parsed = tool.schema.parse(input);
  if (!googleAccount(chat.sender.number)?.scopes.includes(tool.scope)) throw new Error(tool.scope === SCOPES.youtube ? "YouTube isn't connected. Ask them to send /google youtube." : "This person didn't allow that Google app. They can send /google to connect again.");
  if (tool.preview) return propose(tool, parsed, chat, outbox);
  return tool.run(parsed, { number: chat.sender.number, chatId: chat.chatId });
}

// --- Confirming changes --------------------------------------------------------------------------------------------

async function propose(tool: App, input: unknown, chat: ChatContext, outbox: Outbox): Promise<string> {
  const code = String(randomInt(1000, 10_000));
  const summary = tool.preview!(input as never);
  db.prepare("INSERT INTO google_pending (chat_id, number, code, tool, input, summary, status, noted, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)").run(
    chat.chatId,
    chat.sender.number,
    code,
    tool.name,
    JSON.stringify(input),
    summary,
    Date.now(),
  );
  await outbox.sendText(chat.chatId, `⚠️ *Konfirmasi Google*\n${summary}\n\nBalas *YA ${code}* dalam ${CONFIRM_MINUTES} menit untuk menjalankan. Abaikan pesan ini untuk membatalkan.`);
  return "Nothing has changed yet. The person was sent a preview and a code; it runs only when they reply with that code. Don't repeat the preview or the code, and don't say it's done.";
}

type Pending = { id: number; tool: string; input: string; created_at: number };

/**
 * Handles "YA 1234" for a pending Google change. Returns true when the message was that confirmation (handled here,
 * never shown to Claude), false for everything else.
 */
export async function confirmGoogle(chat: ChatContext, text: string, outbox: Outbox): Promise<boolean> {
  const match = googleAllowed(chat) ? CONFIRM.exec(text) : null;
  if (!match) return false;
  const pending = db
    .prepare("SELECT id, tool, input, created_at FROM google_pending WHERE chat_id = ? AND number = ? AND code = ? AND status = 'pending' AND created_at > ? ORDER BY id DESC LIMIT 1")
    .get(chat.chatId, chat.sender.number, match[1], Date.now() - 86_400_000) as Pending | undefined;
  if (!pending) return false;
  const finish = (status: string, result: string) => db.prepare("UPDATE google_pending SET status = ?, result = ? WHERE id = ?").run(status, result, pending.id);
  if (Date.now() - pending.created_at > CONFIRM_MINUTES * 60_000) {
    finish("expired", "The confirmation code expired before it was used.");
    await outbox.sendText(chat.chatId, "Kode konfirmasi itu sudah kedaluwarsa, jadi tidak ada yang berubah. Minta ulang ke saya kalau masih perlu.");
    return true;
  }
  finish("running", "");
  try {
    const tool = APPS.find((t) => t.name === pending.tool);
    if (!tool) throw new Error("That action no longer exists.");
    const result = await tool.run(tool.schema.parse(JSON.parse(pending.input)), { number: chat.sender.number, chatId: chat.chatId });
    finish("done", result);
    await outbox.sendText(chat.chatId, `✅ ${result}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finish("failed", message);
    await outbox.sendText(chat.chatId, `❌ Google tidak menjalankan itu: ${message}`);
  }
  return true;
}

/** What happened to changes Claude proposed in this chat since its last turn, so it knows on the next message. */
export function googleNotes(chat: ChatContext): string | undefined {
  const rows = db
    .prepare("SELECT id, tool, summary, status, result FROM google_pending WHERE chat_id = ? AND noted = 0 AND status NOT IN ('pending', 'running')")
    .all(chat.chatId) as { id: number; tool: string; summary: string; status: string; result: string | null }[];
  if (rows.length === 0) return undefined;
  db.prepare(`UPDATE google_pending SET noted = 1 WHERE id IN (${rows.map(() => "?").join(",")})`).run(...rows.map((r) => r.id));
  const lines = rows.map((r) => `- ${r.tool} ("${r.summary.split("\n")[0]}"): ${r.status}${r.result ? ` — ${r.result}` : ""}`);
  return `[System note — Google changes you proposed earlier:\n${lines.join("\n")}]`;
}
