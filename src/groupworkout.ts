import type { BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { z } from "zod";
import { config, type Contact } from "./config.js";
import { findContact, isAdmin } from "./contacts.js";
import { db } from "./db.js";
import { exerciseCatalog, findExercises, hevyAccount, hevyEnabled, normalizeTitle } from "./hevy.js";
import { checkSet, newExercise, saveWorkout, setsText, workoutSet, type NewExercise, type SetInput } from "./hevyapps.js";
import { formatDateTime, fromLocal } from "./time.js";
import type { ChatContext, Outbox } from "./types.js";

// Group workouts: someone with Hevy invites other Friday contacts to train together. Each invitee joins by replying
// "ikut" in their own private chat, after being told who can log for them, who will see it, and that it all goes into
// their Hevy at the end. Once everyone has joined, any member can log sets for any member, from their private chat or
// the WhatsApp group the session started in. Sets are kept here while it runs; when it ends, each member's workout is
// saved into their own Hevy (as hevy_log_workout would) and they're sent what was saved.

const INVITE_HOURS = 2;
const IDLE_HOURS = 8;
const RESEND_HOURS = 24;
const MAX_MEMBERS = 8;
const HOUR = 3_600_000;
const LB = 0.45359237;

type Session = {
  id: number;
  host: string;
  title: string;
  chat_id: string | null;
  chat_name: string | null;
  status: "inviting" | "active" | "finished" | "cancelled";
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
  updated_at: number;
};
type Member = { workout_id: number; number: string; name: string; status: "invited" | "joined" | "left"; invited_at: number; draft: string; saved: number };
type Logged = { exercise_template_id?: string; new_exercise?: NewExercise; title: string; type?: string; sets: SetInput[]; by: string[] };

const sessionById = (id: number) => db.prepare("SELECT * FROM group_workouts WHERE id = ?").get(id) as Session | undefined;
const membersOf = (id: number) => db.prepare("SELECT * FROM group_workout_members WHERE workout_id = ? AND status != 'left' ORDER BY invited_at, rowid").all(id) as Member[];
const live = (s: Session, now = Date.now()) => (s.status === "inviting" || s.status === "active") && now - s.updated_at < IDLE_HOURS * HOUR;
const touch = (id: number) => db.prepare("UPDATE group_workouts SET updated_at = ? WHERE id = ?").run(Date.now(), id);
const names = (members: Member[]) => members.map((m) => m.name).join(", ");
const draftOf = (m: Member) => JSON.parse(m.draft) as Logged[];
const shown = (sets: SetInput[]) => sets.map((s) => ({ ...s, weight_kg: s.weight_lb !== undefined ? Math.round(s.weight_lb * LB * 100) / 100 : s.weight_kg }));
const hostOf = (s: Session) => membersOf(s.id).find((m) => m.number === s.host)?.name ?? "Host";

/** The live group workout this person has joined (hosts join their own). */
function joinedSession(number: string): Session | undefined {
  const rows = db
    .prepare("SELECT w.* FROM group_workouts w JOIN group_workout_members m ON m.workout_id = w.id WHERE m.number = ? AND m.status = 'joined' AND w.status IN ('inviting', 'active') ORDER BY w.id DESC")
    .all(number) as Session[];
  return rows.find((s) => live(s));
}

/** The session someone can act on from this chat: their private chat, or the WhatsApp group it started in. */
function sessionHere(chat: ChatContext): Session | undefined {
  if (!hevyEnabled || !chat.sender.isContact) return undefined;
  const s = joinedSession(chat.sender.number);
  return s && (!chat.isGroup || chat.chatId === s.chat_id) ? s : undefined;
}

/** A session this person finished lately, so they can have their workout saved again if it didn't go in. */
function recentlyFinished(number: string): Session | undefined {
  return db
    .prepare("SELECT w.* FROM group_workouts w JOIN group_workout_members m ON m.workout_id = w.id WHERE m.number = ? AND m.status = 'joined' AND w.status = 'finished' AND w.finished_at > ? ORDER BY w.id DESC LIMIT 1")
    .get(number, Date.now() - RESEND_HOURS * HOUR) as Session | undefined;
}

/** Tells the members: in the WhatsApp group the session started in, or else each in their private chat. */
async function announce(s: Session, text: string, outbox: Outbox, skip?: string): Promise<void> {
  if (s.chat_id) return outbox.sendText(s.chat_id, text);
  for (const m of membersOf(s.id)) if (m.status === "joined" && m.number !== skip) await outbox.sendText(outbox.chatIdFor(m.number), text).catch(() => {});
}

function memberNamed(s: Session, name: string): Member {
  const members = membersOf(s.id);
  const wanted = name.trim().toLowerCase();
  const exact = members.filter((m) => m.name.toLowerCase() === wanted);
  const loose = exact.length ? exact : members.filter((m) => m.name.toLowerCase().startsWith(wanted) || m.name.toLowerCase().includes(wanted));
  if (loose.length === 1) return loose[0];
  throw new Error(`${loose.length ? `"${name}" could be ${names(loose)}` : `Nobody called "${name}" is in this group workout`}. Members: ${names(members)}.`);
}

// --- Inviting ------------------------------------------------------------------------------------------------------

function contactsNamed(list: string[], sender: ChatContext["sender"]): Contact[] {
  const found = new Map<string, Contact>();
  for (const name of list) {
    const contact = findContact(name);
    // Only the admin learns whether a name is a contact; for anyone else a miss looks like any other failure.
    if (!contact) throw new Error(isAdmin(sender.number) ? `"${name}" isn't a known contact.` : `Can't invite "${name}". Use the name they're saved under with ${config.BOT_NAME}.`);
    if (contact.number !== sender.number) found.set(contact.number, contact);
  }
  return [...found.values()];
}

function inviteText(s: Session, host: string, others: string[], linked: boolean): string {
  const where = s.chat_id ? ` di grup *${s.chat_name}*` : "";
  return [
    "🏋️ *Ajakan workout bareng*",
    `${host} mengajakmu workout bareng${where}: *${s.title}*.`,
    [
      "*Kalau ikut, selama sesi ini:*",
      `- Sesama anggota (${others.join(", ")}) bisa mencatat set untukmu dan melihat catatanmu${s.chat_id ? `, dan catatannya terlihat oleh semua anggota grup *${s.chat_name}*` : ""}.`,
      "- Saat sesi selesai, workout-mu langsung disimpan ke Hevy-mu, dan kamu dapat ringkasannya.",
    ].join("\n"),
    ...(linked ? [] : ["Kamu perlu Hevy dulu: kirim /hevy untuk menghubungkannya."]),
    `Balas *ikut* dalam ${INVITE_HOURS} jam untuk bergabung, atau *gak ikut* kalau tidak bisa.`,
  ].join("\n\n");
}

async function sendInvites(s: Session, contacts: Contact[], outbox: Outbox): Promise<string[]> {
  const current = membersOf(s.id);
  const fresh = contacts.filter((c) => !current.some((m) => m.number === c.number));
  if (current.length + fresh.length > MAX_MEMBERS) throw new Error(`A group workout has at most ${MAX_MEMBERS} people.`);
  const now = Date.now();
  for (const c of fresh) {
    db.prepare("INSERT OR REPLACE INTO group_workout_members (workout_id, number, name, status, invited_at, draft, saved) VALUES (?, ?, ?, 'invited', ?, '[]', 0)").run(s.id, c.number, c.name, now);
  }
  const all = membersOf(s.id);
  const host = hostOf(s);
  for (const c of fresh) {
    const others = all.filter((x) => x.number !== c.number).map((x) => x.name);
    await outbox.sendText(outbox.chatIdFor(c.number), inviteText(s, host, others, Boolean(hevyAccount(c.number))));
  }
  touch(s.id);
  return fresh.map((c) => c.name);
}

/** Starts the session once nobody is still invited and at least two have joined. */
async function startIfReady(id: number, outbox: Outbox): Promise<void> {
  const s = sessionById(id)!;
  const members = membersOf(id);
  const joined = members.filter((m) => m.status === "joined");
  if (s.status !== "inviting" || members.some((m) => m.status === "invited") || joined.length < 2) return;
  const now = Date.now();
  db.prepare("UPDATE group_workouts SET status = 'active', started_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
  const example = joined.find((m) => m.number !== s.host) ?? joined[0];
  await announce(s, `💪 Semua sudah ikut: ${names(joined)}. *${s.title}* dimulai!\nCatat set siapa saja ke saya, misalnya: "${example.name} squat 40 kg 3x10, aku 60 kg 3x8". Kalau sudah, bilang "selesai".`, outbox);
}

// Short replies to an invite. A message counts only while an invite is open, and only if it's nothing but these words.
const JOIN = new Set(["ikut", "ikutan", "join", "gas", "ayo", "yuk", "bisa"]);
const YES = new Set(["ya", "iya", "yes", "ok", "oke", "okay", "siap", "aku", "saya"]);
const NO = new Set(["tidak", "nggak", "ngga", "enggak", "engga", "gak", "ga", "gk", "tdk", "ndak", "no"]);

export function inviteAnswer(text: string): "join" | "decline" | undefined {
  const words = text.toLowerCase().replace(/[^\p{L}\s]/gu, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return undefined;
  const join = words.some((w) => JOIN.has(w));
  if ((join && words.some((w) => NO.has(w))) || (words.length === 1 && (words[0] === "skip" || words[0] === "absen"))) return "decline";
  if (join && words.every((w) => JOIN.has(w) || YES.has(w))) return "join";
  return undefined;
}

/**
 * Handles "ikut" or "gak ikut" from someone with an open group workout invite, in their private chat. True when the
 * message was that (handled here, never shown to Claude).
 */
export async function answerGroupInvite(chat: ChatContext, text: string, outbox: Outbox): Promise<boolean> {
  if (!hevyEnabled || chat.isGroup || !chat.sender.isContact) return false;
  const answer = inviteAnswer(text);
  if (!answer) return false;
  const m = db
    .prepare("SELECT * FROM group_workout_members WHERE number = ? AND status IN ('invited', 'left') AND invited_at > ? ORDER BY invited_at DESC LIMIT 1")
    .get(chat.sender.number, Date.now() - RESEND_HOURS * HOUR) as Member | undefined;
  if (!m) return false;
  const s = sessionById(m.workout_id)!;
  const reply = (t: string) => outbox.sendText(chat.chatId, t);
  if (m.status === "left") {
    if (answer === "decline") return false; // nothing to answer
    await reply(`Kamu tidak lagi diajak di *${s.title}*, jadi tidak ada yang berubah.`);
    return true;
  }
  if (!live(s)) {
    await reply("Workout bareng itu sudah selesai atau dibatalkan.");
    return true;
  }
  if (answer === "decline") {
    db.prepare("UPDATE group_workout_members SET status = 'left' WHERE workout_id = ? AND number = ?").run(s.id, m.number);
    touch(s.id);
    await reply(`Oke, kamu tidak ikut *${s.title}*.`);
    await announce(s, `🙅 ${m.name} tidak ikut *${s.title}*.`, outbox, m.number);
    await startIfReady(s.id, outbox);
    return true;
  }
  if (Date.now() - m.invited_at > INVITE_HOURS * HOUR) {
    await reply(`Ajakan itu sudah kedaluwarsa. Minta ${hostOf(s)} mengajakmu lagi.`);
    return true;
  }
  if (!hevyAccount(chat.sender.number)) {
    await reply("Hubungkan Hevy dulu: kirim /hevy, lalu balas *ikut* lagi.");
    return true;
  }
  const other = joinedSession(chat.sender.number);
  if (other && other.id !== s.id) {
    await reply(`Kamu masih ikut workout bareng *${other.title}*. Selesaikan atau keluar dulu, lalu balas *ikut* lagi.`);
    return true;
  }
  db.prepare("UPDATE group_workout_members SET status = 'joined' WHERE workout_id = ? AND number = ?").run(s.id, m.number);
  touch(s.id);
  const waiting = membersOf(s.id).filter((x) => x.status === "invited");
  const where = s.chat_id ? ` di sini atau di grup *${s.chat_name}*` : " di sini";
  if (s.status === "active") {
    await reply(`✅ Kamu ikut *${s.title}*, yang sedang berjalan. Catat set-mu${where}.`);
    await announce(s, `👋 ${m.name} ikut *${s.title}*.`, outbox, m.number);
  } else if (waiting.length) {
    await reply(`✅ Kamu ikut *${s.title}*. Menunggu: ${names(waiting)}.`);
    await announce(s, `👋 ${m.name} ikut *${s.title}*. Menunggu: ${names(waiting)}.`, outbox, m.number);
  } else if (s.chat_id) {
    await reply(`✅ Kamu ikut *${s.title}*. Catat set-mu${where}.`); // the start is announced in the group, not here
  }
  await startIfReady(s.id, outbox);
  return true;
}

// --- Finishing -----------------------------------------------------------------------------------------------------

/** Saves one member's workout from the session into their own Hevy, and tells them. */
async function saveFor(s: Session, m: Member, outbox: Outbox): Promise<string> {
  if (m.saved) return `${m.name}: already in their Hevy`;
  const draft = draftOf(m);
  const chatId = outbox.chatIdFor(m.number);
  if (draft.length === 0) {
    await outbox.sendText(chatId, `🏁 *${s.title}* selesai. Tidak ada set yang tercatat untukmu, jadi Hevy-mu tidak berubah.`);
    return `${m.name}: nothing logged`;
  }
  const others = membersOf(s.id).filter((x) => x.status === "joined" && x.number !== m.number).map((x) => x.name);
  const start = s.started_at ?? s.created_at;
  const input = {
    title: s.title,
    start: new Date(start).toISOString(),
    end: new Date(Math.max(s.finished_at ?? Date.now(), start + 60_000)).toISOString(),
    description: others.length ? `Workout bareng ${others.join(", ")}` : undefined,
    exercises: draft.map((d) => ({ ...(d.exercise_template_id ? { exercise_template_id: d.exercise_template_id } : { new_exercise: d.new_exercise }), sets: d.sets })),
  };
  try {
    await saveWorkout({ number: m.number, chatId }, input, outbox, `🏁 *${s.title}* selesai!${others.length ? ` Workout bareng ${others.join(", ")}.` : ""}`);
    db.prepare("UPDATE group_workout_members SET saved = 1 WHERE workout_id = ? AND number = ?").run(s.id, m.number);
    return `${m.name}: saved in their Hevy`;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await outbox.sendText(chatId, `🏁 *${s.title}* selesai, tapi workout-mu belum tersimpan ke Hevy (${reason}). Bilang "simpan workout bareng tadi" untuk mencoba lagi.`).catch(() => {});
    return `${m.name}: not saved (${reason})`;
  }
}

// --- The tools -----------------------------------------------------------------------------------------------------

type Ctx = { chat: ChatContext; outbox: Outbox };
type Tool<S extends z.ZodObject = z.ZodObject> = { name: string; description: string; schema: S; run: (input: z.infer<S>, ctx: Ctx) => Promise<string> };
const tool = <S extends z.ZodObject>(t: Tool<S>) => t as unknown as Tool;

function needSession(chat: ChatContext): Session {
  const s = sessionHere(chat);
  if (!s) throw new Error("They aren't in a group workout reachable from this chat.");
  return s;
}

const loggedExercise = z.object({
  name: z.string().min(1).max(100).describe('English, the way Hevy titles it, with the equipment: "Squat (Barbell)", "Leg Press (Machine)".'),
  exercise_template_id: z.string().optional().describe("Only an id this tool offered as a candidate for that member."),
  new_exercise: newExercise.optional().describe("When that member's Hevy has nothing like it; it's created in their Hevy when they save."),
  sets: z.array(workoutSet).min(1).max(60),
});

const START = tool({
  name: "group_workout_start",
  description:
    "Start a group workout: invite other Friday contacts by name to train together. Each gets a private invite and joins by replying \"ikut\". " +
    "Once everyone has joined, members can log sets for each other with group_workout_log, and group_workout_finish saves each member's " +
    "workout into their own Hevy.",
  schema: z.object({
    title: z.string().min(1).max(100).describe('e.g. "Leg day bareng".'),
    invite: z.array(z.string().min(1).max(100)).min(1).max(MAX_MEMBERS - 1).describe("The names of the other people."),
  }),
  async run({ title, invite }, { chat, outbox }) {
    if (!hevyAccount(chat.sender.number)) throw new Error("They need to connect Hevy first with /hevy.");
    const current = joinedSession(chat.sender.number);
    if (current) throw new Error(`They're already in the group workout "${current.title}". Finish or cancel it first.`);
    const contacts = contactsNamed(invite, chat.sender);
    if (contacts.length === 0) throw new Error("Invite at least one other person.");
    const now = Date.now();
    const id = Number(
      db
        .prepare("INSERT INTO group_workouts (host, title, chat_id, chat_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'inviting', ?, ?)")
        .run(chat.sender.number, title.replace(/[\r\n]+/g, " ").trim(), chat.isGroup ? chat.chatId : null, chat.isGroup ? chat.chatName : null, now, now).lastInsertRowid,
    );
    db.prepare("INSERT INTO group_workout_members (workout_id, number, name, status, invited_at) VALUES (?, ?, ?, 'joined', ?)").run(id, chat.sender.number, chat.sender.name, now);
    const invited = await sendInvites(sessionById(id)!, contacts, outbox);
    return `Invites sent to ${invited.join(", ")}, each privately; they join by replying "ikut", and you'll be told as they do. Sets can be logged once everyone has joined. If someone isn't coming, the host can remove them with group_workout_members.`;
  },
});

const LIVE = [
  tool({
    name: "group_workout_log",
    description:
      "Log sets in the group workout for one member (anyone in it, or the person talking). Sets add to what's there; replace: true " +
      "starts that member's log over. Give exercise names; if one is unclear, this answers with candidates to pick from.",
    schema: z.object({
      member: z.string().optional().describe("Whose sets, by name. Omit for the person talking."),
      replace: z.boolean().default(false),
      exercises: z.array(loggedExercise).min(1).max(30),
    }),
    async run({ member, replace, exercises }, { chat, outbox }) {
      const s = needSession(chat);
      if (s.status !== "active") {
        const waiting = membersOf(s.id).filter((m) => m.status === "invited");
        throw new Error(`Not everyone has joined yet (waiting for ${names(waiting)}). Sets can be logged once they have; the host can remove anyone who isn't coming.`);
      }
      const target = member ? memberNamed(s, member) : membersOf(s.id).find((m) => m.number === chat.sender.number)!;
      if (target.status !== "joined") throw new Error(`${target.name} hasn't joined yet.`);
      const catalog = await exerciseCatalog(target.number);
      const added: Logged[] = exercises.map((item) => {
        let template = item.exercise_template_id ? catalog.find((t) => t.id === item.exercise_template_id) : undefined;
        if (item.exercise_template_id && !template) throw new Error(`${target.name}'s Hevy has no exercise ${item.exercise_template_id}. Give its name instead.`);
        if (!template && !item.new_exercise) {
          const [best, next] = findExercises(catalog, item.name);
          const clear = best && (best.score === 1 || (best.score >= 0.8 && (!next || best.score - next.score >= 0.1)));
          if (!clear) {
            const options = findExercises(catalog, item.name).map((m) => `${m.template.id} | ${m.template.title}`);
            throw new Error(`Not sure which exercise "${item.name}" is in ${target.name}'s Hevy. ${options.length ? `Candidates: ${options.join("; ")}. Pass exercise_template_id, or ask.` : "Nothing similar; pass new_exercise to create it."}`);
          }
          template = best.template;
        }
        const title = template?.title ?? item.new_exercise!.title;
        const type = template?.type ?? item.new_exercise!.exercise_type;
        for (const set of item.sets) checkSet(set, type, title);
        return { ...(template ? { exercise_template_id: template.id } : { new_exercise: item.new_exercise }), title, type, sets: item.sets, by: [chat.sender.name] };
      });
      const draft = replace ? [] : draftOf(target);
      for (const entry of added) {
        const same = draft.find((d) => (entry.exercise_template_id ? d.exercise_template_id === entry.exercise_template_id : !d.exercise_template_id && normalizeTitle(d.title) === normalizeTitle(entry.title)));
        if (!same) draft.push(entry);
        else {
          same.sets.push(...entry.sets);
          if (!same.by.includes(chat.sender.name)) same.by.push(chat.sender.name);
        }
      }
      db.prepare("UPDATE group_workout_members SET draft = ? WHERE workout_id = ? AND number = ?").run(JSON.stringify(draft), s.id, target.number);
      touch(s.id);
      const lines = added.map((e) => `${e.title}: ${setsText(shown(e.sets), "id", e.type)}`);
      // Outside the session's group, the member wouldn't otherwise see what someone logged for them.
      if (target.number !== chat.sender.number && !(chat.isGroup && chat.chatId === s.chat_id)) {
        await outbox.sendText(outbox.chatIdFor(target.number), `📝 ${chat.sender.name} mencatat untukmu di *${s.title}*:\n${lines.join("\n")}`).catch(() => {});
      }
      const total = draft.reduce((n, d) => n + d.sets.length, 0);
      return `Logged for ${target.name}: ${added.map((e) => `${e.title} ${setsText(shown(e.sets), "en", e.type)}`).join("; ")}. ${target.name} has ${draft.length} exercises, ${total} sets so far. Confirm it in one short line.`;
    },
  }),
  tool({
    name: "group_workout_status",
    description: "Who is in the group workout and every set logged for each member so far.",
    schema: z.object({}),
    async run(_input, { chat }) {
      const s = needSession(chat);
      const head = `Group workout "${s.title}", host ${hostOf(s)}, ${s.status === "active" ? `on since ${formatDateTime(new Date(s.started_at!))}` : "waiting for everyone to join"}${s.chat_id ? ` (in the WhatsApp group ${s.chat_name}, and private chats)` : " (in private chats)"}.`;
      const rows = membersOf(s.id).map((m) => {
        if (m.status === "invited") return `- ${m.name}: invited ${formatDateTime(new Date(m.invited_at))}, hasn't joined${Date.now() - m.invited_at > INVITE_HOURS * HOUR ? " (invite expired; invite again or remove)" : ""}`;
        const draft = draftOf(m);
        return draft.length ? `- ${m.name}:\n${draft.map((d) => `  ${d.title}: ${setsText(shown(d.sets), "en", d.type)} (by ${d.by.join(", ")})`).join("\n")}` : `- ${m.name}: nothing logged yet`;
      });
      return [head, ...rows].join("\n");
    },
  }),
  tool({
    name: "group_workout_members",
    description: "Invite more people to the group workout, or remove someone (the host can remove anyone; others can only leave).",
    schema: z.object({ invite: z.array(z.string().min(1)).max(MAX_MEMBERS - 1).optional(), remove: z.array(z.string().min(1)).max(MAX_MEMBERS).optional() }),
    async run({ invite, remove }, { chat, outbox }) {
      const s = needSession(chat);
      const isHost = s.host === chat.sender.number;
      const done: string[] = [];
      if (invite?.length) {
        if (!isHost) throw new Error(`Only the host, ${hostOf(s)}, can invite people.`);
        const invited = await sendInvites(s, contactsNamed(invite, chat.sender), outbox);
        if (invited.length) done.push(`Invited ${invited.join(", ")}.`);
      }
      for (const name of remove ?? []) {
        const m = memberNamed(s, name);
        if (m.number === s.host) throw new Error("The host can't leave; cancel the group workout instead.");
        if (!isHost && m.number !== chat.sender.number) throw new Error(`Only the host, ${hostOf(s)}, can remove someone else.`);
        db.prepare("UPDATE group_workout_members SET status = 'left' WHERE workout_id = ? AND number = ?").run(s.id, m.number);
        if (m.status === "joined") await outbox.sendText(outbox.chatIdFor(m.number), `Kamu sudah tidak ikut *${s.title}*. Set yang tercatat untukmu di sesi itu dibuang.`).catch(() => {});
        done.push(`${m.name} is out${draftOf(m).length ? " (their logged sets were dropped)" : ""}.`);
      }
      touch(s.id);
      await startIfReady(s.id, outbox);
      const now = sessionById(s.id)!;
      return `${done.join(" ") || "Nothing changed."} ${now.status === "active" && s.status === "inviting" ? "Everyone left has joined, so it has started." : ""}`.trim();
    },
  }),
  tool({
    name: "group_workout_finish",
    description:
      "End the group workout for everyone: each member's workout is saved into their own Hevy and they're sent what was saved. " +
      "Afterwards, a member whose workout didn't go in (Hevy unreachable) can call it again in their private chat to save theirs.",
    schema: z.object({ end: z.string().optional().describe('Local end time if not now, "2026-11-04T19:30".') }),
    async run({ end }, { chat, outbox }) {
      const s = sessionHere(chat);
      if (!s) {
        const past = !chat.isGroup && recentlyFinished(chat.sender.number);
        if (!past) throw new Error("They aren't in a group workout.");
        const me = membersOf(past.id).find((m) => m.number === chat.sender.number)!;
        return `${await saveFor(past, me, outbox)}.`;
      }
      if (s.status !== "active") throw new Error(`It hasn't started: waiting for ${names(membersOf(s.id).filter((m) => m.status === "invited"))}. Remove them, or cancel.`);
      const finishedAt = Math.min(end ? fromLocal(end).getTime() : Date.now(), Date.now());
      db.prepare("UPDATE group_workouts SET status = 'finished', finished_at = ?, updated_at = ? WHERE id = ?").run(finishedAt, Date.now(), s.id);
      const done = sessionById(s.id)!;
      if (done.chat_id) await outbox.sendText(done.chat_id, `🏁 *${s.title}* selesai! Workout masing-masing saya simpan ke Hevy-nya, ringkasannya di chat pribadi.`);
      const results: string[] = [];
      for (const m of membersOf(s.id).filter((x) => x.status === "joined")) results.push(await saveFor(done, m, outbox));
      return `Finished. ${results.join("; ")}. Each member was sent their own summary privately.`;
    },
  }),
  tool({
    name: "group_workout_cancel",
    description: "Cancel the group workout (host only). Nothing logged in it is saved.",
    schema: z.object({}),
    async run(_input, { chat, outbox }) {
      const s = needSession(chat);
      if (s.host !== chat.sender.number) throw new Error(`Only the host, ${hostOf(s)}, can cancel it. They can leave with group_workout_members.`);
      db.prepare("UPDATE group_workouts SET status = 'cancelled', updated_at = ? WHERE id = ?").run(Date.now(), s.id);
      await announce(s, `❌ ${hostOf(s)} membatalkan *${s.title}*. Tidak ada yang disimpan.`, outbox, chat.isGroup ? undefined : chat.sender.number);
      return "Cancelled; everyone was told.";
    },
  }),
];

const ALL = [START, ...LIVE];
const FINISH = LIVE.find((t) => t.name === "group_workout_finish")!;

function chosen(chat: ChatContext): Tool[] {
  if (!hevyEnabled || !chat.sender.isContact || !hevyAccount(chat.sender.number)) return [];
  if (sessionHere(chat)) return LIVE;
  if (joinedSession(chat.sender.number)) return []; // in one that runs in another chat
  return !chat.isGroup && recentlyFinished(chat.sender.number) ? [START, FINISH] : [START];
}

function jsonSchema(schema: z.ZodObject) {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return json as { type: "object"; [key: string]: unknown };
}

export function groupWorkoutTools(chat: ChatContext): BetaToolUnion[] {
  return chosen(chat).map((t) => ({ name: t.name, description: t.description, input_schema: jsonSchema(t.schema), eager_input_streaming: true }));
}

/** Runs a group_workout_* tool. Returns undefined if `name` isn't one. */
export async function runGroupWorkoutTool(name: string, input: unknown, chat: ChatContext, outbox: Outbox): Promise<string | undefined> {
  if (!name.startsWith("group_workout_")) return undefined;
  const t = chosen(chat).find((x) => x.name === name);
  if (!t) throw new Error(ALL.some((x) => x.name === name) ? "That group workout tool isn't available to this person in this chat right now." : `No tool called ${name}.`);
  return t.run(t.schema.parse(input), { chat, outbox });
}

/** A line for Claude while the sender is in a group workout reachable from this chat. */
export function groupWorkoutNote(chat: ChatContext): string | undefined {
  const s = sessionHere(chat);
  if (!s) return undefined;
  const members = membersOf(s.id).map((m) => `${m.name}${m.status === "invited" ? " (invited)" : ""}`);
  return `[Group workout "${s.title}" is ${s.status === "active" ? "on" : "waiting for everyone to join"}: ${members.join(", ")}. Log sets for any member with group_workout_log.]`;
}

/** Takes someone out of every group workout, e.g. when they stop being a contact. */
export function leaveGroupWorkouts(number: string): void {
  db.prepare("UPDATE group_workout_members SET status = 'left' WHERE number = ? AND status != 'left'").run(number);
}
