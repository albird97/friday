import { randomInt } from "node:crypto";
import type { BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { z } from "zod";
import { config } from "./config.js";
import { db } from "./db.js";
import { exerciseCatalog, findExercises, forgetCatalog, hevy, hevyAccount, hevyAllowed, HevyError, normalizeTitle, unwrap, type Template } from "./hevy.js";
import { formatDateTime, fromLocal, localDay } from "./time.js";
import type { ChatContext, Outbox } from "./types.js";

// What Friday can do in someone's own Hevy. Reading runs straight away. Anything that changes Hevy only proposes:
// the code below checks the input against their exercises, builds the preview from it (not from Claude's words) and
// keeps that exact plan. It runs only when the person answers the one-time code, which this file checks. A misread
// photo or a wrong guess is caught there, and Hevy's API has no delete, so a wrong save would have to be undone by hand.

const CONFIRM_MINUTES = 10;
const CONFIRM = /^\s*(?:ya|yes)\s+(\d{4})\s*[.!]?\s*$/i;
const MAX_CHARS = 20_000;
const LB = 0.45359237;
const DAY = 86_400_000;

const SET_TYPES = ["normal", "warmup", "failure", "dropset"] as const;
const EXERCISE_TYPES = ["weight_reps", "reps_only", "bodyweight_reps", "bodyweight_assisted_reps", "duration", "weight_duration", "distance_duration", "short_distance_weight"] as const;
const EQUIPMENT = ["none", "barbell", "dumbbell", "kettlebell", "machine", "plate", "resistance_band", "suspension", "other"] as const;
const MUSCLES = ["abdominals", "shoulders", "biceps", "triceps", "forearms", "quadriceps", "hamstrings", "calves", "glutes", "abductors", "adductors", "lats", "upper_back", "traps", "lower_back", "chest", "cardio", "neck", "full_body", "other"] as const;
const RPE = [6, 7, 7.5, 8, 8.5, 9, 9.5, 10];

type ExerciseType = (typeof EXERCISE_TYPES)[number];
type Ctx = { number: string; chatId: string };

// --- Wording -------------------------------------------------------------------------------------------------------

type Lang = "id" | "en";
const TYPE_ID: Record<string, string> = {
  weight_reps: "beban & repetisi",
  reps_only: "repetisi saja",
  bodyweight_reps: "bodyweight (+beban)",
  bodyweight_assisted_reps: "bodyweight dibantu",
  duration: "durasi",
  weight_duration: "beban & durasi",
  distance_duration: "jarak & durasi",
  short_distance_weight: "beban & jarak",
};
const MUSCLE_ID: Record<string, string> = {
  abdominals: "perut", shoulders: "bahu", biceps: "bisep", triceps: "trisep", forearms: "lengan bawah", quadriceps: "paha depan",
  hamstrings: "paha belakang", calves: "betis", glutes: "bokong", abductors: "abduktor", adductors: "adduktor", lats: "lats",
  upper_back: "punggung atas", traps: "trapezius", lower_back: "punggung bawah", chest: "dada", cardio: "kardio", neck: "leher",
  full_body: "seluruh tubuh", other: "lainnya",
};
const EQUIPMENT_ID: Record<string, string> = {
  none: "tanpa alat", barbell: "barbel", dumbbell: "dumbel", kettlebell: "kettlebell", machine: "mesin", plate: "plate",
  resistance_band: "resistance band", suspension: "suspension/TRX", other: "lainnya",
};
const LABELS = {
  id: { warmup: "pemanasan", failure: "sampai gagal", dropset: "drop set", reps: "rep", rest: "istirahat", metric: "lantai/langkah", empty: "(kosong)" },
  en: { warmup: "warm-up", failure: "to failure", dropset: "drop set", reps: "reps", rest: "rest", metric: "floors/steps", empty: "(empty)" },
};

const idNumber = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });
const num = (n: number, lang: Lang) => (lang === "id" ? idNumber.format(n) : String(Math.round(n * 100) / 100));
const pad = (n: number) => String(n).padStart(2, "0");
const clock = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h ? `${h}:${pad(m)}:${pad(s)}` : m ? `${m}:${pad(s)}` : `${s}s`;
};
const span = (ms: number, lang: Lang) => {
  const minutes = Math.round(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (lang === "en") return h ? `${h}h${m ? `${pad(m)}m` : ""}` : `${m} min`;
  return h ? `${h} jam${m ? ` ${m} mnt` : ""}` : `${m} mnt`;
};
const idDateTime = new Intl.DateTimeFormat("id-ID", { timeZone: config.TIMEZONE, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const idTime = new Intl.DateTimeFormat("id-ID", { timeZone: config.TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: false });
const idDate = new Intl.DateTimeFormat("id-ID", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" });
const dateText = (day: string) => idDate.format(new Date(`${day}T00:00:00Z`));
const when = (startIso: string, endIso: string) => `${idDateTime.format(new Date(startIso))}–${idTime.format(new Date(endIso))} (${span(Date.parse(endIso) - Date.parse(startIso), "id")})`;
const line = (text: string) => text.replace(/[\r\n]+/g, " ").trim();
const clip = (text: string) => (text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[…cut, ${text.length} characters in all]` : text);
const plural = (n: number, word: string) => `${n} ${word}`;
/** Joins preview lines, leaving out the parts a condition turned off. */
const joinLines = (parts: unknown[]) => parts.filter((p): p is string => typeof p === "string").join("\n");

type SetLike = {
  type?: string | null;
  weight_kg?: number | null;
  reps?: number | null;
  distance_meters?: number | null;
  duration_seconds?: number | null;
  rpe?: number | null;
  custom_metric?: number | null;
  rep_range?: { start?: number | null; end?: number | null } | null;
};

function setText(s: SetLike, lang: Lang, exerciseType?: string): string {
  const L = LABELS[lang];
  const range = s.rep_range?.start != null ? (s.rep_range.end != null && s.rep_range.end !== s.rep_range.start ? `${s.rep_range.start}–${s.rep_range.end}` : String(s.rep_range.start)) : undefined;
  const reps = s.reps != null ? String(s.reps) : range;
  const parts: string[] = [];
  if (s.weight_kg != null) {
    const sign = s.weight_kg > 0 && exerciseType === "bodyweight_reps" ? "+" : s.weight_kg > 0 && exerciseType === "bodyweight_assisted_reps" ? "−" : "";
    parts.push(reps !== undefined ? `${sign}${num(s.weight_kg, lang)} kg × ${reps}` : `${sign}${num(s.weight_kg, lang)} kg`);
  } else if (reps !== undefined) parts.push(`${reps} ${L.reps}`);
  if (s.distance_meters != null) parts.push(s.distance_meters >= 1000 ? `${num(s.distance_meters / 1000, lang)} km` : `${num(s.distance_meters, lang)} m`);
  if (s.duration_seconds != null) parts.push(clock(s.duration_seconds));
  if (s.custom_metric != null) parts.push(`${num(s.custom_metric, lang)} ${L.metric}`);
  let text = parts.join(" · ") || L.empty;
  if (s.rpe != null) text += ` @RPE ${num(s.rpe, lang)}`;
  const label = s.type === "warmup" || s.type === "failure" || s.type === "dropset" ? L[s.type] : undefined;
  return label ? `${text} (${label})` : text;
}

/** "40 kg × 10 (pemanasan), 3× 80 kg × 8": identical sets in a row are counted once. */
function setsText(sets: SetLike[], lang: Lang, exerciseType?: string): string {
  const groups: { text: string; count: number }[] = [];
  for (const s of sets) {
    const text = setText(s, lang, exerciseType);
    const last = groups.at(-1);
    if (last?.text === text) last.count++;
    else groups.push({ text, count: 1 });
  }
  return groups.map((g) => (g.count > 1 ? `${g.count}× ${g.text}` : g.text)).join(", ");
}

// --- Hevy's data ---------------------------------------------------------------------------------------------------

type ApiSet = {
  type: string;
  weight_kg: number | null;
  reps: number | null;
  distance_meters: number | null;
  duration_seconds: number | null;
  custom_metric: number | null;
  rpe?: number | null;
  rep_range?: { start: number; end: number } | null;
};
type Exercise = { index?: number; title?: string; notes?: string | null; exercise_template_id?: string; supersets_id?: number | null; superset_id?: number | null; rest_seconds?: number | null; sets?: SetLike[] };
type Workout = { id: string; title?: string; description?: string | null; routine_id?: string | null; start_time: string; end_time: string; exercises?: Exercise[] };
type Routine = { id: string; title?: string; folder_id?: number | null; notes?: string | null; exercises?: Exercise[] };
type Folder = { id: number; title?: string };
type Measurement = { date: string } & Record<string, number | string | null | undefined>;

const utc = (date: Date) => `${date.toISOString().slice(0, 19)}Z`;
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
const dayRange = (from?: string, to?: string) => ({ from: from ? fromLocal(from) : undefined, to: to ? fromLocal(nextDay(to)) : undefined });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

/** Pages through a Hevy list (10 per page at most), stopping where `enough` says or after `maxPages`. */
async function pages<T>(number: string, path: string, key: string, maxPages: number, enough?: (page: T[], all: T[]) => boolean): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    let body: Record<string, unknown> | undefined;
    try {
      body = await hevy(number, path, { query: { page, pageSize: 10 } });
    } catch (err) {
      if (err instanceof HevyError && err.status === 404 && page > 1) break; // past the last page
      throw err;
    }
    const items = (body?.[key] as T[] | undefined) ?? [];
    all.push(...items);
    const count = typeof body?.page_count === "number" ? body.page_count : undefined;
    if (items.length === 0 || (count !== undefined ? page >= count : items.length < 10) || enough?.(items, all)) break;
  }
  return all;
}

/** Workouts that started in [from, to), newest first. Hevy lists newest first, so paging stops once a page is all older. */
async function workoutsBetween(number: string, from?: Date, to?: Date, limit = 10, maxPages = 20): Promise<Workout[]> {
  const inRange = (w: Workout) => (!from || Date.parse(w.start_time) >= from.getTime()) && (!to || Date.parse(w.start_time) < to.getTime());
  const all = await pages<Workout>(number, "/workouts", "workouts", maxPages, (page, seen) =>
    from ? page.every((w) => Date.parse(w.start_time) < from.getTime()) : seen.filter(inRange).length >= limit,
  );
  return all.filter(inRange).sort((a, b) => Date.parse(b.start_time) - Date.parse(a.start_time)).slice(0, limit);
}

function describeWorkout(w: Workout): string {
  const head = `- ${w.id} | ${formatDateTime(new Date(w.start_time))} (${span(Date.parse(w.end_time) - Date.parse(w.start_time), "en")}) | ${line(w.title ?? "(untitled)")}`;
  const body = (w.exercises ?? []).map((e, i) => `  ${i + 1}. ${e.title ?? e.exercise_template_id}: ${setsText(e.sets ?? [], "en")}`);
  return [head, ...body].join("\n");
}

/** A workout as Hevy's edit wants it back. GET calls the superset "supersets_id"; PUT wants "superset_id". */
const keepWorkoutExercises = (w: Workout) =>
  (w.exercises ?? []).map((e) => ({
    exercise_template_id: e.exercise_template_id,
    superset_id: e.supersets_id ?? e.superset_id ?? null,
    notes: e.notes ?? null,
    sets: (e.sets ?? []).map((s) => ({
      type: s.type ?? "normal",
      weight_kg: s.weight_kg ?? null,
      reps: s.reps ?? null,
      distance_meters: s.distance_meters ?? null,
      duration_seconds: s.duration_seconds ?? null,
      rpe: s.rpe ?? null,
      custom_metric: s.custom_metric ?? null,
    })),
  }));

const keepRoutineExercises = (r: Routine) =>
  (r.exercises ?? []).map((e) => ({
    exercise_template_id: e.exercise_template_id,
    superset_id: e.supersets_id ?? e.superset_id ?? null,
    rest_seconds: e.rest_seconds ?? null,
    notes: e.notes ?? null,
    sets: (e.sets ?? []).map((s) => ({
      type: s.type ?? "normal",
      weight_kg: s.weight_kg ?? null,
      reps: s.reps ?? null,
      distance_meters: s.distance_meters ?? null,
      duration_seconds: s.duration_seconds ?? null,
      custom_metric: s.custom_metric ?? null,
      ...(s.rep_range?.start != null && s.rep_range.end != null && { rep_range: { start: s.rep_range.start, end: s.rep_range.end } }),
    })),
  }));

const isoSeconds = (value: string) => utc(new Date(value));

function rememberPrivacy(number: string, workoutId: string | undefined, isPrivate: boolean): void {
  if (workoutId) db.prepare("INSERT OR REPLACE INTO hevy_privacy (workout_id, number, is_private) VALUES (?, ?, ?)").run(workoutId, number, isPrivate ? 1 : 0);
}
function knownPrivacy(number: string, workoutId: string): boolean | undefined {
  const row = db.prepare("SELECT is_private FROM hevy_privacy WHERE workout_id = ? AND number = ?").get(workoutId, number) as { is_private: number } | undefined;
  return row ? row.is_private === 1 : undefined;
}

// --- Checking what Claude wants to save -----------------------------------------------------------------------------

const newExercise = z.object({
  title: z.string().min(2).max(100).describe('English, Hevy style: "Name (Equipment)", e.g. "Hip Thrust (Machine)".'),
  exercise_type: z.enum(EXERCISE_TYPES),
  equipment_category: z.enum(EQUIPMENT),
  muscle_group: z.enum(MUSCLES),
  other_muscles: z.array(z.enum(MUSCLES)).max(6).optional(),
});
type NewExercise = z.infer<typeof newExercise>;

const rpe = z
  .number()
  .refine((v) => RPE.includes(v), "rpe must be 6, 7, 7.5, 8, 8.5, 9, 9.5 or 10.")
  .optional()
  .describe("6, 7, 7.5, 8, 8.5, 9, 9.5 or 10.");
const setFields = {
  type: z.enum(SET_TYPES).default("normal"),
  weight_kg: z.number().min(0).max(1000).optional().describe("Load in kg. Bodyweight exercises: added weight. Assisted ones: the assistance."),
  weight_lb: z.number().min(0).max(2200).optional().describe("Instead of weight_kg, when they lift in pounds."),
  reps: z.number().int().min(0).max(1000).optional(),
  distance_meters: z.number().min(0).max(1_000_000).optional(),
  duration_seconds: z.number().int().min(0).max(86_400).optional(),
  custom_metric: z.number().min(0).optional().describe("Floors or steps, for stair machines."),
};
const workoutSet = z.object({ ...setFields, rpe });
const routineSet = z.object({
  ...setFields,
  reps: setFields.reps.describe("Target reps."),
  rep_range: z.object({ start: z.number().int().min(1), end: z.number().int().min(1) }).optional().describe("Instead of reps, e.g. 8–12. The Hevy app may show only the first number."),
});
const exerciseRef = {
  exercise_template_id: z.string().optional().describe("From hevy_find_exercises."),
  new_exercise: newExercise.optional().describe("Only when hevy_find_exercises has nothing that fits; it's created first, with the same confirmation."),
  notes: z.string().max(500).optional(),
  superset: z.number().int().min(0).max(20).optional().describe("The same number on exercises done as one superset."),
};
const workoutExercise = z.object({ ...exerciseRef, sets: z.array(workoutSet).min(1).max(60) });
const routineExercise = z.object({ ...exerciseRef, rest_seconds: z.number().int().min(0).max(900).optional(), sets: z.array(routineSet).min(1).max(30) });
type SetInput = z.infer<typeof routineSet> & { rpe?: number };
type ExerciseInput = { exercise_template_id?: string; new_exercise?: NewExercise; notes?: string; superset?: number; rest_seconds?: number; sets: SetInput[] };

type Planned = { template_id?: string; create?: NewExercise; title: string; type?: string; isNew: boolean; notes: string | null; superset: number | null; rest_seconds: number | null; sets: ApiSet[] };

// Which measurements each kind of exercise records. Anything else is refused, so nothing they said is silently dropped.
const VALUES = ["weight_kg", "reps", "distance_meters", "duration_seconds"] as const;
type Value = (typeof VALUES)[number];
const RULES: Record<ExerciseType, { takes: Value[]; needs: Value[]; needsOne?: Value[] }> = {
  weight_reps: { takes: ["weight_kg", "reps"], needs: ["weight_kg", "reps"] },
  reps_only: { takes: ["reps"], needs: ["reps"] },
  bodyweight_reps: { takes: ["weight_kg", "reps"], needs: ["reps"] },
  bodyweight_assisted_reps: { takes: ["weight_kg", "reps"], needs: ["reps"] },
  duration: { takes: ["duration_seconds"], needs: ["duration_seconds"] },
  weight_duration: { takes: ["weight_kg", "duration_seconds"], needs: ["duration_seconds"] },
  distance_duration: { takes: ["distance_meters", "duration_seconds"], needs: [], needsOne: ["distance_meters", "duration_seconds"] },
  short_distance_weight: { takes: ["weight_kg", "distance_meters"], needs: ["distance_meters"] },
};

function toApiSet(s: SetInput, type: string | undefined, title: string, routine: boolean): ApiSet {
  if (s.weight_kg !== undefined && s.weight_lb !== undefined) throw new Error(`${title}: give weight_kg or weight_lb, not both.`);
  const values: Record<Value, number | undefined> = {
    weight_kg: s.weight_lb !== undefined ? Math.round(s.weight_lb * LB * 1000) / 1000 : s.weight_kg,
    reps: s.reps,
    distance_meters: s.distance_meters === undefined ? undefined : Math.round(s.distance_meters),
    duration_seconds: s.duration_seconds,
  };
  const rule = RULES[type as ExerciseType];
  if (rule) {
    const label = `${title} records ${type!.replace(/_/g, " ")}`;
    for (const value of VALUES) if (values[value] !== undefined && !rule.takes.includes(value)) throw new Error(`${label}, so a set can't have ${value === "weight_kg" && s.weight_lb !== undefined ? "weight_lb" : value}. Use another exercise if that's what they did.`);
    if (!routine) {
      for (const value of rule.needs) if (values[value] === undefined) throw new Error(`${label}: every set needs ${value}${value === "weight_kg" ? " (or weight_lb)" : ""}. Ask them if you don't know it.`);
      if (rule.needsOne && rule.needsOne.every((value) => values[value] === undefined)) throw new Error(`${label}: every set needs ${rule.needsOne.join(" or ")}.`);
    }
    if (s.rep_range && !rule.takes.includes("reps")) throw new Error(`${label}, so it can't have a rep range.`);
  }
  if (s.rep_range && s.rep_range.end < s.rep_range.start) throw new Error(`${title}: a rep range has to go from low to high.`);
  if (s.rep_range && s.reps !== undefined) throw new Error(`${title}: give reps or rep_range, not both.`);
  const set: ApiSet = {
    type: s.type,
    weight_kg: values.weight_kg ?? null,
    reps: values.reps ?? null,
    distance_meters: values.distance_meters ?? null,
    duration_seconds: values.duration_seconds ?? null,
    custom_metric: s.custom_metric ?? null,
  };
  if (routine) set.rep_range = s.rep_range ?? null;
  else set.rpe = s.rpe ?? null;
  return set;
}

/** Checks every exercise against their Hevy: ids must exist, new ones mustn't duplicate an existing title. */
async function planExercises(number: string, items: ExerciseInput[], routine: boolean): Promise<Planned[]> {
  const catalog = await exerciseCatalog(number);
  const byId = new Map(catalog.map((t) => [t.id, t]));
  return items.map((item, i) => {
    if (Boolean(item.exercise_template_id) === Boolean(item.new_exercise)) throw new Error(`Exercise ${i + 1}: give exactly one of exercise_template_id or new_exercise.`);
    let template: Template | undefined;
    if (item.exercise_template_id) {
      template = byId.get(item.exercise_template_id);
      if (!template) throw new Error(`Exercise ${i + 1}: there's no exercise "${item.exercise_template_id}" in their Hevy. Use an id from hevy_find_exercises.`);
    } else {
      // An exercise with this name already exists (maybe made a minute ago): use it rather than make a twin.
      template = catalog.find((t) => normalizeTitle(t.title) === normalizeTitle(item.new_exercise!.title));
    }
    const create = template ? undefined : item.new_exercise;
    const title = template?.title ?? line(create!.title);
    const type = template?.type ?? create?.exercise_type;
    return {
      template_id: template?.id,
      create,
      title,
      type,
      isNew: Boolean(create),
      notes: item.notes?.trim() || null,
      superset: item.superset ?? null,
      rest_seconds: routine ? (item.rest_seconds ?? null) : null,
      sets: item.sets.map((s) => toApiSet(s, type, title, routine)),
    };
  });
}

async function createTemplate(number: string, x: NewExercise): Promise<string> {
  const body = await hevy(number, "/exercise_templates", {
    method: "POST",
    json: { exercise: { title: line(x.title), exercise_type: x.exercise_type, equipment_category: x.equipment_category, muscle_group: x.muscle_group, other_muscles: x.other_muscles ?? [] } },
  });
  forgetCatalog(number);
  const id = body?.id ?? body?.exercise_template?.id ?? body?.exercise_template_id ?? (typeof body === "string" || typeof body === "number" ? body : undefined);
  if (id !== undefined && id !== null && id !== "") return String(id);
  const found = (await exerciseCatalog(number, true)).find((t) => normalizeTitle(t.title) === normalizeTitle(x.title));
  if (!found) throw new HevyError(`Hevy accepted the new exercise "${x.title}" but didn't say its id. Check the app before trying again.`);
  return found.id;
}

/** Creates the planned new exercises (each title once, and not if it appeared meanwhile). Returns the titles made. */
async function createMissing(number: string, exercises: Planned[]): Promise<string[]> {
  const missing = exercises.filter((e) => !e.template_id && e.create);
  if (missing.length === 0) return [];
  const catalog = await exerciseCatalog(number, true);
  const ids = new Map<string, string>();
  const made: string[] = [];
  for (const e of missing) {
    const key = normalizeTitle(e.create!.title);
    let id = ids.get(key) ?? catalog.find((t) => normalizeTitle(t.title) === key)?.id;
    if (!id) {
      id = await createTemplate(number, e.create!);
      made.push(e.title);
    }
    ids.set(key, id);
    e.template_id = id;
  }
  return made;
}

function exerciseLines(exercises: Planned[], routine: boolean): string[] {
  return exercises.map((e, i) => {
    const isNew = e.isNew && e.create ? ` ✨ _baru: ${TYPE_ID[e.create.exercise_type]} · ${EQUIPMENT_ID[e.create.equipment_category]} · ${MUSCLE_ID[e.create.muscle_group]}_` : "";
    const extras = [e.superset !== null && `superset ${e.superset + 1}`, routine && e.rest_seconds !== null && `${LABELS.id.rest} ${clock(e.rest_seconds)}`].filter(Boolean).join(" · ");
    const notes = e.notes ? `\n   _${line(e.notes)}_` : "";
    return `${i + 1}. *${e.title}*${isNew}\n   ${setsText(e.sets, "id", e.type)}${extras ? ` · ${extras}` : ""}${notes}`;
  });
}
const countSets = (exercises: { sets: unknown[] }[]) => exercises.reduce((n, e) => n + e.sets.length, 0);

function workoutTimes(start: string, end: string | undefined, minutes: number | undefined, now = Date.now()) {
  const s = fromLocal(start);
  const e = end ? fromLocal(end) : minutes ? new Date(s.getTime() + minutes * 60_000) : undefined;
  if (!e) throw new Error("Give end or duration_minutes. If they didn't say, estimate about 3 minutes per set and tell them.");
  if (e <= s) throw new Error("The workout has to end after it starts.");
  if (e.getTime() - s.getTime() > 12 * 3_600_000) throw new Error("That's over 12 hours; check the start and end.");
  if (e.getTime() > now + 10 * 60_000) throw new Error("That ends in the future. Hevy logs workouts that already happened; for a plan, make a routine.");
  return { start_time: utc(s), end_time: utc(e) };
}

/** Another workout at the same time, which usually means it's already logged (in the app, or earlier here). */
async function overlapping(number: string, start: string, end: string, except?: string): Promise<Workout | undefined> {
  const recent = await workoutsBetween(number, new Date(Date.parse(start) - DAY), undefined, 10, 2).catch(() => []);
  return recent.find((w) => w.id !== except && Date.parse(w.start_time) < Date.parse(end) && Date.parse(w.end_time) > Date.parse(start));
}

const privacyText = (isPrivate: boolean) => (isPrivate ? "🔒 Privat (hanya kamu)" : "🌍 Publik (terlihat followers)");

const MEASURES = {
  weight_kg: ["weight_kg", "Berat", "kg"],
  lean_mass_kg: ["lean_mass_kg", "Massa tanpa lemak", "kg"],
  fat_percent: ["fat_percent", "Lemak tubuh", "%"],
  neck_cm: ["neck_cm", "Leher", "cm"],
  shoulder_cm: ["shoulder_cm", "Bahu", "cm"],
  chest_cm: ["chest_cm", "Dada", "cm"],
  left_bicep_cm: ["left_bicep_cm", "Lengan atas kiri", "cm"],
  right_bicep_cm: ["right_bicep_cm", "Lengan atas kanan", "cm"],
  left_forearm_cm: ["left_forearm_cm", "Lengan bawah kiri", "cm"],
  right_forearm_cm: ["right_forearm_cm", "Lengan bawah kanan", "cm"],
  abdomen_cm: ["abdomen", "Perut", "cm"],
  waist_cm: ["waist", "Pinggang", "cm"],
  hips_cm: ["hips", "Pinggul", "cm"],
  left_thigh_cm: ["left_thigh", "Paha kiri", "cm"],
  right_thigh_cm: ["right_thigh", "Paha kanan", "cm"],
  left_calf_cm: ["left_calf", "Betis kiri", "cm"],
  right_calf_cm: ["right_calf", "Betis kanan", "cm"],
} as const;
type MeasureKey = keyof typeof MEASURES;
const MEASURE_KEYS = Object.keys(MEASURES) as MeasureKey[];
const cm = z.number().min(5).max(300).optional().describe("cm");
const API_MEASURES = MEASURE_KEYS.map((k) => MEASURES[k][0]);

async function measurementOn(number: string, date: string): Promise<Measurement | undefined> {
  try {
    const body = await hevy(number, `/body_measurements/${date}`);
    const m = unwrap<Measurement>(body, "body_measurement");
    return m && API_MEASURES.some((k) => typeof m[k] === "number") ? m : undefined;
  } catch (err) {
    if (err instanceof HevyError && err.status === 404) return undefined;
    throw err;
  }
}

// --- The tools -----------------------------------------------------------------------------------------------------

type Reader<S extends z.ZodObject = z.ZodObject> = { name: string; description: string; schema: S; read: (input: z.infer<S>, ctx: Ctx) => Promise<string> };
type Writer<S extends z.ZodObject = z.ZodObject, P = any> = {
  name: string;
  description: string;
  schema: S;
  /** Checks the input and returns what to show and the exact plan to run once confirmed. */
  prepare: (input: z.infer<S>, ctx: Ctx) => Promise<{ preview: string; plan: P; warning?: string }>;
  /** Runs a confirmed plan. `text` goes to the person; `detail` only to Claude. */
  apply: (plan: P, ctx: Ctx) => Promise<{ text: string; detail?: string }>;
};
type Tool = Reader | Writer;
const reader = <S extends z.ZodObject>(t: Reader<S>) => t as unknown as Tool;
const writer = <S extends z.ZodObject, P>(t: Writer<S, P>) => t as unknown as Tool;

const READERS = [
  reader({
    name: "hevy_workouts",
    description: "List this person's logged workouts with every exercise and set: the most recent ones, or those between two local dates.",
    schema: z.object({
      from: day.optional().describe("First local day, YYYY-MM-DD."),
      to: day.optional().describe("Last local day (inclusive). Default: today."),
      limit: z.number().int().min(1).max(40).optional().describe("Default 5, or every workout (up to 40) when from is given."),
    }),
    async read({ from, to, limit }, { number }) {
      const range = dayRange(from, to);
      const list = await workoutsBetween(number, range.from, range.to, limit ?? (from ? 40 : 5));
      return list.length ? clip(list.map(describeWorkout).join("\n")) : "No workouts in that period.";
    },
  }),
  reader({
    name: "hevy_get_workout",
    description: "One workout in full: exercise ids, every set with its type and RPE, notes, supersets. Use before hevy_update_workout.",
    schema: z.object({ workout_id: z.string().min(1) }),
    async read({ workout_id }, { number }) {
      const w = unwrap<Workout>(await hevy(number, `/workouts/${encodeURIComponent(workout_id)}`), "workout");
      if (!w?.id) return `No workout ${workout_id}.`;
      const lines = [
        `Workout ${w.id}: ${line(w.title ?? "(untitled)")}`,
        `When: ${formatDateTime(new Date(w.start_time))} to ${formatDateTime(new Date(w.end_time))} (${span(Date.parse(w.end_time) - Date.parse(w.start_time), "en")})`,
        w.description && `Description: ${line(w.description)}`,
        w.routine_id && `From routine ${w.routine_id}`,
        `Privacy: ${{ true: "private", false: "public", undefined: "unknown (Hevy's API doesn't say)" }[String(knownPrivacy(number, w.id)) as "true"]}`,
        ...(w.exercises ?? []).flatMap((e, i) => [
          `${i + 1}. ${e.title} [${e.exercise_template_id}]${(e.supersets_id ?? e.superset_id) != null ? ` (superset ${e.supersets_id ?? e.superset_id})` : ""}${e.notes ? ` notes: ${line(e.notes)}` : ""}`,
          ...(e.sets ?? []).map((s, j) => `   ${j + 1}. ${setText(s, "en")}`),
        ]),
      ];
      return clip(lines.filter(Boolean).join("\n"));
    },
  }),
  reader({
    name: "hevy_find_exercises",
    description:
      "Find exercises in this person's Hevy (built-in and their own) for the names you read or heard. One call with every name. " +
      'Write names in English the way Hevy titles them, e.g. "Bench Press (Barbell)", "Lat Pulldown (Cable)", "Plank". Gives the best matches with ids.',
    schema: z.object({
      names: z.array(z.string().min(1).max(100)).min(1).max(30),
      muscle_group: z.enum(MUSCLES).optional().describe("Only exercises for this primary muscle."),
    }),
    async read({ names, muscle_group }, { number }) {
      let catalog = await exerciseCatalog(number);
      // The list is kept for a while, so a name with no match gets one fresh look (they may have just made it in the app).
      if (names.some((name) => findExercises(catalog, name, muscle_group).length === 0)) catalog = await exerciseCatalog(number, true);
      if (catalog.length === 0) return "Hevy returned no exercises; try again in a minute.";
      return clip(
        names
          .map((name) => {
            const matches = findExercises(catalog, name, muscle_group);
            if (matches.length === 0) return `"${name}": no match. Try another name, or use new_exercise.`;
            const rows = matches.map(({ template: t, score }) => `  - ${t.id} | ${t.title} | ${t.type ?? "?"} | ${t.primary_muscle_group ?? "?"}${t.is_custom ? " | their own" : ""}${score === 1 ? " | exact" : ""}`);
            return [`"${name}":`, ...rows].join("\n");
          })
          .join("\n"),
      );
    },
  }),
  reader({
    name: "hevy_exercise_history",
    description: "Every time this person did one exercise: sets per session, best weight, best estimated 1RM (Epley), most reps, and the trend. For progress, PRs and what to lift next.",
    schema: z.object({ exercise_template_id: z.string().min(1), from: day.optional(), to: day.optional() }),
    async read({ exercise_template_id, from, to }, { number }) {
      const range = dayRange(from, to);
      const body = await hevy<{ exercise_history?: (SetLike & { workout_id: string; workout_title?: string; workout_start_time: string; set_type?: string })[] }>(
        number,
        `/exercise_history/${encodeURIComponent(exercise_template_id)}`,
        { query: { start_date: range.from?.toISOString(), end_date: range.to?.toISOString() } },
      );
      const entries = body?.exercise_history ?? [];
      const title = (await exerciseCatalog(number)).find((t) => t.id === exercise_template_id)?.title ?? exercise_template_id;
      if (entries.length === 0) return `No ${title} logged in that period.`;
      const sessions = new Map<string, { title?: string; start: string; sets: SetLike[] }>();
      for (const e of entries) {
        const session = sessions.get(e.workout_id) ?? { title: e.workout_title, start: e.workout_start_time, sets: [] };
        session.sets.push({ ...e, type: e.set_type ?? e.type });
        sessions.set(e.workout_id, session);
      }
      const ordered = [...sessions.values()].sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
      const work = entries.filter((e) => (e.set_type ?? e.type) !== "warmup");
      const dateOf = (e: { workout_start_time: string }) => localDay(new Date(e.workout_start_time));
      const e1rm = (e: SetLike) => (e.weight_kg && e.reps && e.reps <= 12 ? e.weight_kg * (1 + e.reps / 30) : 0);
      const heaviest = work.filter((e) => e.weight_kg != null).sort((a, b) => b.weight_kg! - a.weight_kg! || (b.reps ?? 0) - (a.reps ?? 0))[0];
      const strongest = [...work].sort((a, b) => e1rm(b) - e1rm(a))[0];
      const mostReps = work.filter((e) => e.reps != null).sort((a, b) => b.reps! - a.reps!)[0];
      const best = [
        heaviest && `heaviest ${setText(heaviest, "en")} on ${dateOf(heaviest)}`,
        strongest && e1rm(strongest) > 0 && `best estimated 1RM ${num(e1rm(strongest), "en")} kg (${setText(strongest, "en")}) on ${dateOf(strongest)}`,
        mostReps && `most reps ${setText(mostReps, "en")} on ${dateOf(mostReps)}`,
      ].filter(Boolean);
      const top = (sets: SetLike[]) => Math.max(0, ...sets.filter((s) => s.type !== "warmup").map(e1rm));
      const trend = ordered.length > 1 && top(ordered.at(-1)!.sets) > 0 && top(ordered[0].sets) > 0 ? `Estimated 1RM went from ${num(top(ordered.at(-1)!.sets), "en")} to ${num(top(ordered[0].sets), "en")} kg over ${ordered.length} sessions.` : "";
      const rows = ordered.slice(0, 15).map((s) => `- ${localDay(new Date(s.start))} ${line(s.title ?? "")}: ${setsText(s.sets, "en")}`);
      return clip([`${title}: ${ordered.length} sessions.`, best.length ? `Bests: ${best.join("; ")}.` : "", trend, ...rows, ordered.length > 15 ? `(${ordered.length - 15} older sessions not shown)` : ""].filter(Boolean).join("\n"));
    },
  }),
  reader({
    name: "hevy_routines",
    description: "List this person's routines (saved plans they start in the app) and folders, optionally matching words in the title.",
    schema: z.object({ search: z.string().optional() }),
    async read({ search }, { number }) {
      const [routines, folders] = await Promise.all([pages<Routine>(number, "/routines", "routines", 10), pages<Folder>(number, "/routine_folders", "routine_folders", 5)]);
      const folderName = new Map(folders.map((f) => [f.id, f.title ?? String(f.id)]));
      const wanted = search ? routines.filter((r) => normalizeTitle(r.title ?? "").includes(normalizeTitle(search))) : routines;
      const rows = wanted.map(
        (r) =>
          `- ${r.id} | ${line(r.title ?? "(untitled)")}${r.folder_id != null ? ` | folder ${folderName.get(r.folder_id) ?? r.folder_id}` : ""} | ${(r.exercises ?? []).map((e) => `${e.title} ${plural(e.sets?.length ?? 0, "sets")}`).join(", ")}`,
      );
      const folderLine = folders.length ? `Folders: ${folders.map((f) => `${f.id} "${f.title}"`).join(", ")}` : "No folders.";
      return clip([folderLine, ...(rows.length ? rows : [search ? `No routine matching "${search}".` : "No routines yet."])].join("\n"));
    },
  }),
  reader({
    name: "hevy_get_routine",
    description: "One routine in full: exercise ids, target sets, rep ranges, rest times and notes. Use before hevy_update_routine.",
    schema: z.object({ routine_id: z.string().min(1) }),
    async read({ routine_id }, { number }) {
      const r = unwrap<Routine>(await hevy(number, `/routines/${encodeURIComponent(routine_id)}`), "routine");
      if (!r?.id) return `No routine ${routine_id}.`;
      const lines = [
        `Routine ${r.id}: ${line(r.title ?? "(untitled)")}${r.folder_id != null ? ` (folder ${r.folder_id})` : ""}`,
        r.notes && `Notes: ${line(r.notes)}`,
        ...(r.exercises ?? []).flatMap((e, i) => [
          `${i + 1}. ${e.title} [${e.exercise_template_id}]${e.rest_seconds ? ` rest ${clock(e.rest_seconds)}` : ""}${(e.supersets_id ?? e.superset_id) != null ? ` (superset ${e.supersets_id ?? e.superset_id})` : ""}${e.notes ? ` notes: ${line(e.notes)}` : ""}`,
          `   ${setsText(e.sets ?? [], "en")}`,
        ]),
      ];
      return clip(lines.filter(Boolean).join("\n"));
    },
  }),
  reader({
    name: "hevy_measurements",
    description: "This person's body measurements in Hevy (weight, body fat, sizes), newest first.",
    schema: z.object({ from: day.optional(), to: day.optional() }),
    async read({ from, to }, { number }) {
      const all = await pages<Measurement>(number, "/body_measurements", "body_measurements", 10);
      const rows = all
        .filter((m) => (!from || m.date >= from) && (!to || m.date <= to))
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 60)
        .map((m) => {
          const values = MEASURE_KEYS.filter((k) => typeof m[MEASURES[k][0]] === "number").map((k) => `${k.replace(/_(kg|cm|percent)$/, "")} ${m[MEASURES[k][0]]}${MEASURES[k][2] === "%" ? "%" : ` ${MEASURES[k][2]}`}`);
          return `- ${m.date}: ${values.join(", ")}`;
        });
      return rows.length ? rows.join("\n") : "No body measurements in that period.";
    },
  }),
  reader({
    name: "hevy_stats",
    description: "Training summary for a period: how often, how long, sets per muscle, most-done exercises, volume, breaks. For weekly or monthly recaps and coaching.",
    schema: z.object({ from: day.describe("First local day."), to: day.optional().describe("Last local day (inclusive). Default: today.") }),
    async read({ from, to }, { number }) {
      const last = to ?? localDay();
      const range = dayRange(from, last);
      const [workouts, catalog, count] = await Promise.all([
        workoutsBetween(number, range.from, range.to, 400, 40),
        exerciseCatalog(number),
        hevy<{ workout_count?: number }>(number, "/workouts/count").catch(() => undefined),
      ]);
      if (workouts.length === 0) return `No workouts between ${from} and ${last}.${count?.workout_count ? ` (${count.workout_count} workouts in Hevy overall.)` : ""}`;
      const muscleOf = new Map(catalog.map((t) => [t.id, t.primary_muscle_group ?? "other"]));
      const weeks = Math.max(1, (range.to!.getTime() - range.from!.getTime()) / (7 * DAY));
      let seconds = 0;
      let sets = 0;
      let volume = 0;
      const perMuscle = new Map<string, number>();
      const perExercise = new Map<string, { sets: number; best?: SetLike }>();
      const perWeek = new Map<string, number>();
      for (const w of workouts) {
        seconds += (Date.parse(w.end_time) - Date.parse(w.start_time)) / 1000;
        const local = localDay(new Date(w.start_time));
        const date = new Date(`${local}T00:00:00Z`);
        const monday = new Date(date.getTime() - ((date.getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
        perWeek.set(monday, (perWeek.get(monday) ?? 0) + 1);
        for (const e of w.exercises ?? []) {
          const work = (e.sets ?? []).filter((s) => s.type !== "warmup");
          sets += work.length;
          for (const s of e.sets ?? []) if (s.weight_kg && s.reps) volume += s.weight_kg * s.reps;
          const muscle = muscleOf.get(e.exercise_template_id ?? "") ?? "other";
          perMuscle.set(muscle, (perMuscle.get(muscle) ?? 0) + work.length);
          const name = e.title ?? e.exercise_template_id ?? "?";
          const entry = perExercise.get(name) ?? { sets: 0 };
          entry.sets += work.length;
          for (const s of work) if (s.weight_kg != null && (!entry.best || s.weight_kg > (entry.best.weight_kg ?? 0))) entry.best = s;
          perExercise.set(name, entry);
        }
      }
      const days = [...new Set(workouts.map((w) => localDay(new Date(w.start_time))))].sort();
      const gaps = days.slice(1).map((d, i) => Math.round((Date.parse(d) - Date.parse(days[i])) / DAY));
      const sinceLast = Math.round((Date.parse(localDay()) - Date.parse(days.at(-1)!)) / DAY);
      const top = [...perExercise.entries()].sort((a, b) => b[1].sets - a[1].sets).slice(0, 10);
      return clip(
        [
          `${workouts.length} workouts between ${from} and ${last} (${num(workouts.length / weeks, "en")} a week), ${span(seconds * 1000, "en")} in all, ${sets} working sets, volume ${Math.round(volume).toLocaleString("en-US")} kg (weight × reps).`,
          `Per week (starting Monday): ${[...perWeek.entries()].sort().map(([w, n]) => `${w}: ${n}`).join(", ")}`,
          `Working sets per primary muscle: ${[...perMuscle.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(", ")}`,
          `Most done: ${top.map(([name, e]) => `${name} ${e.sets} sets${e.best ? ` (heaviest ${setText(e.best, "en")})` : ""}`).join("; ")}`,
          `Last workout ${days.at(-1)} (${sinceLast} days ago)${gaps.length ? `, longest break ${Math.max(...gaps)} days` : ""}.${count?.workout_count ? ` ${count.workout_count} workouts in Hevy overall.` : ""}`,
        ].join("\n"),
      );
    },
  }),
];

type WorkoutPlan = { title: string; description: string | null; start_time: string; end_time: string; is_private: boolean; exercises: Planned[] };
type WorkoutEdit = Omit<WorkoutPlan, "exercises"> & { workout_id: string; exercises: Planned[] | null };
type RoutinePlan = { title: string; notes: string | null; exercises: Planned[] };
type RoutinesPlan = { folder: { id: number | null; create: string | null; title: string } | null; routines: RoutinePlan[] };
type RoutineEdit = { routine_id: string; title: string; notes: string | null; exercises: Planned[] | null };

const apiWorkoutExercises = (exercises: Planned[]) => exercises.map((e) => ({ exercise_template_id: e.template_id, superset_id: e.superset, notes: e.notes, sets: e.sets }));
const apiRoutineExercises = (exercises: Planned[]) =>
  exercises.map((e) => ({ exercise_template_id: e.template_id, superset_id: e.superset, rest_seconds: e.rest_seconds, notes: e.notes, sets: e.sets }));
const madeText = (made: string[]) => (made.length ? ` Latihan baru: ${made.join(", ")}.` : "");

const WRITERS = [
  writer({
    name: "hevy_log_workout",
    description:
      "Propose saving a finished workout to this person's Hevy, from what they told you, a voice note or a photo. Get exercise ids from hevy_find_exercises first. " +
      "They get a preview to confirm with a code.",
    schema: z.object({
      title: z.string().min(1).max(100).describe('Short, e.g. "Push Day", "Lari pagi"; the routine name if they followed one.'),
      start: z.string().describe('Local start, "2026-11-04T07:00".'),
      end: z.string().optional().describe("Local end. Or give duration_minutes."),
      duration_minutes: z.number().int().min(1).max(720).optional(),
      description: z.string().max(2000).optional(),
      is_private: z.boolean().optional().describe("Default true: only they see it. false shares it with their Hevy followers."),
      exercises: z.array(workoutExercise).min(1).max(40),
    }),
    async prepare(input, { number }) {
      const times = workoutTimes(input.start, input.end, input.duration_minutes);
      const exercises = await planExercises(number, input.exercises, false);
      const plan: WorkoutPlan = { title: line(input.title), description: input.description?.trim() || null, ...times, is_private: input.is_private ?? true, exercises };
      const twin = await overlapping(number, times.start_time, times.end_time);
      const preview = [
        "🏋️ *Simpan workout ke Hevy*",
        `*${plan.title}* · ${when(plan.start_time, plan.end_time)}`,
        privacyText(plan.is_private),
        plan.description && `_${line(plan.description)}_`,
        "",
        ...exerciseLines(exercises, false),
        "",
        `${plural(exercises.length, "latihan")}, ${plural(countSets(exercises), "set")}`,
      ];
      const warning = twin && `Sudah ada workout di jam yang sama: *${line(twin.title ?? "")}* (${when(twin.start_time, twin.end_time)}). Jangan konfirmasi kalau ini workout yang sama.`;
      return { preview: joinLines(preview), plan, warning: warning || undefined };
    },
    async apply(plan: WorkoutPlan, { number }) {
      const made = await createMissing(number, plan.exercises);
      const { exercises, ...rest } = plan;
      const body = await hevy(number, "/workouts", { method: "POST", json: { workout: { ...rest, exercises: apiWorkoutExercises(exercises) } } });
      const saved = unwrap<Workout>(body, "workout");
      rememberPrivacy(number, saved?.id, plan.is_private);
      return {
        text: `Workout tersimpan di Hevy: *${plan.title}* (${plural(exercises.length, "latihan")}, ${plural(countSets(exercises), "set")}).${madeText(made)}`,
        detail: saved?.id ? `workout id ${saved.id}` : "Hevy didn't return the workout id",
      };
    },
  }),
  writer({
    name: "hevy_update_workout",
    description:
      "Propose changing a logged workout: title, time, description, privacy, or its exercises. To change any set, read it with hevy_get_workout " +
      "and pass the complete new exercises list (it replaces them all). Omit exercises to keep them.",
    schema: z.object({
      workout_id: z.string().min(1),
      title: z.string().min(1).max(100).optional(),
      start: z.string().optional().describe("New local start. The length stays the same unless end or duration_minutes is given."),
      end: z.string().optional(),
      duration_minutes: z.number().int().min(1).max(720).optional(),
      description: z.string().max(2000).optional(),
      is_private: z.boolean().optional().describe("Hevy's API demands it on every edit but never reveals the current value; ask if they care."),
      exercises: z.array(workoutExercise).min(1).max(40).optional(),
    }),
    async prepare(input, { number }) {
      const current = unwrap<Workout>(await hevy(number, `/workouts/${encodeURIComponent(input.workout_id)}`), "workout");
      if (!current?.id) throw new Error(`There's no workout ${input.workout_id} in their Hevy.`);
      const length = Date.parse(current.end_time) - Date.parse(current.start_time);
      const times =
        input.start || input.end || input.duration_minutes
          ? workoutTimes(input.start ?? current.start_time, input.end, input.end ? undefined : (input.duration_minutes ?? Math.round(length / 60_000)))
          : { start_time: isoSeconds(current.start_time), end_time: isoSeconds(current.end_time) };
      const known = knownPrivacy(number, current.id);
      const isPrivate = input.is_private ?? known ?? true;
      const exercises = input.exercises ? await planExercises(number, input.exercises, false) : null;
      const plan: WorkoutEdit = {
        workout_id: current.id,
        title: input.title ? line(input.title) : (current.title ?? "Workout"),
        description: input.description !== undefined ? input.description.trim() || null : (current.description ?? null),
        ...times,
        is_private: isPrivate,
        exercises,
      };
      const timeChanged = times.start_time !== isoSeconds(current.start_time) || times.end_time !== isoSeconds(current.end_time);
      const preview = [
        "✏️ *Ubah workout di Hevy*",
        `*${line(current.title ?? "")}* · ${when(current.start_time, current.end_time)}`,
        "",
        plan.title !== current.title && `Judul baru: *${plan.title}*`,
        timeChanged && `Waktu baru: ${when(plan.start_time, plan.end_time)}`,
        input.description !== undefined && `Deskripsi baru: _${line(plan.description ?? "(kosong)")}_`,
        `Privasi: ${privacyText(isPrivate)}${input.is_private === undefined && known === undefined ? "\n_Hevy tidak memberi tahu setelan lamanya; bilang kalau workout ini harus tetap publik._" : ""}`,
        ...(exercises ? ["", "Latihan (menggantikan semua yang lama):", ...exerciseLines(exercises, false)] : []),
      ];
      return { preview: joinLines(preview), plan };
    },
    async apply(plan: WorkoutEdit, { number }) {
      const made = plan.exercises ? await createMissing(number, plan.exercises) : [];
      const current = unwrap<Workout>(await hevy(number, `/workouts/${encodeURIComponent(plan.workout_id)}`), "workout");
      if (!current?.id) throw new HevyError("That workout isn't in Hevy any more.");
      const { workout_id, exercises, ...rest } = plan;
      await hevy(number, `/workouts/${encodeURIComponent(workout_id)}`, {
        method: "PUT",
        json: { workout: { ...rest, exercises: exercises ? apiWorkoutExercises(exercises) : keepWorkoutExercises(current) } },
      });
      rememberPrivacy(number, workout_id, plan.is_private);
      return { text: `Workout diubah di Hevy: *${plan.title}*.${madeText(made)}` };
    },
  }),
  writer({
    name: "hevy_create_exercise",
    description: "Propose adding a custom exercise to this person's Hevy, for one that isn't there (check hevy_find_exercises first). Logging a workout can do this by itself with new_exercise.",
    schema: newExercise,
    async prepare(input, { number }) {
      const existing = (await exerciseCatalog(number)).find((t) => normalizeTitle(t.title) === normalizeTitle(input.title));
      if (existing) throw new Error(`"${existing.title}" already exists in their Hevy (id ${existing.id}).`);
      const preview = [
        "✨ *Buat latihan baru di Hevy*",
        `*${line(input.title)}*`,
        `Jenis: ${TYPE_ID[input.exercise_type]}`,
        `Alat: ${EQUIPMENT_ID[input.equipment_category]}`,
        `Otot utama: ${MUSCLE_ID[input.muscle_group]}${input.other_muscles?.length ? `, lainnya: ${input.other_muscles.map((m) => MUSCLE_ID[m]).join(", ")}` : ""}`,
      ].join("\n");
      return { preview, plan: input };
    },
    async apply(plan: NewExercise, { number }) {
      const existing = (await exerciseCatalog(number, true)).find((t) => normalizeTitle(t.title) === normalizeTitle(plan.title));
      if (existing) return { text: `Latihan *${existing.title}* sudah ada di Hevy.`, detail: `exercise_template_id ${existing.id}` };
      const id = await createTemplate(number, plan);
      return { text: `Latihan baru dibuat di Hevy: *${line(plan.title)}*.`, detail: `exercise_template_id ${id}` };
    },
  }),
  writer({
    name: "hevy_create_routines",
    description:
      "Propose new routines (workout plans they can start in the Hevy app), one or a whole program, optionally in a folder, with one confirmation. " +
      "Get exercise ids from hevy_find_exercises; use new_exercise only for what isn't there.",
    schema: z.object({
      folder_id: z.number().int().optional().describe("An existing folder, from hevy_routines."),
      new_folder: z.string().min(1).max(100).optional().describe("Or a folder to create (an existing one with this name is reused)."),
      routines: z
        .array(z.object({ title: z.string().min(1).max(100), notes: z.string().max(2000).optional(), exercises: z.array(routineExercise).min(1).max(40) }))
        .min(1)
        .max(10),
    }),
    async prepare(input, { number }) {
      if (input.folder_id !== undefined && input.new_folder) throw new Error("Give folder_id or new_folder, not both.");
      let folder: RoutinesPlan["folder"] = null;
      if (input.folder_id !== undefined || input.new_folder) {
        const folders = await pages<Folder>(number, "/routine_folders", "routine_folders", 5);
        const found = input.folder_id !== undefined ? folders.find((f) => f.id === input.folder_id) : folders.find((f) => normalizeTitle(f.title ?? "") === normalizeTitle(input.new_folder!));
        if (input.folder_id !== undefined && !found) throw new Error(`There's no folder ${input.folder_id}. Use hevy_routines to see their folders.`);
        folder = found ? { id: found.id, create: null, title: found.title ?? String(found.id) } : { id: null, create: line(input.new_folder!), title: line(input.new_folder!) };
      }
      const routines: RoutinePlan[] = [];
      for (const r of input.routines) routines.push({ title: line(r.title), notes: r.notes?.trim() || null, exercises: await planExercises(number, r.exercises, true) });
      const preview = [
        `📋 *Buat ${routines.length > 1 ? `${routines.length} rutinitas` : "rutinitas"} di Hevy*`,
        folder && `Folder: *${folder.title}*${folder.create ? " (baru)" : ""}`,
        ...routines.flatMap((r) => ["", `*${r.title}*`, ...(r.notes ? [`_${line(r.notes)}_`] : []), ...exerciseLines(r.exercises, true)]),
      ];
      return { preview: joinLines(preview), plan: { folder, routines } };
    },
    async apply(plan: RoutinesPlan, { number }) {
      let folderId = plan.folder?.id ?? null;
      if (plan.folder?.create) {
        const body = await hevy(number, "/routine_folders", { method: "POST", json: { routine_folder: { title: plan.folder.create } } });
        folderId = unwrap<Folder>(body, "routine_folder")?.id ?? null;
        if (folderId === null) throw new HevyError(`Hevy made the folder "${plan.folder.create}" but didn't say its id. Check the app before trying again.`);
      }
      const made = await createMissing(number, plan.routines.flatMap((r) => r.exercises));
      const done: string[] = [];
      try {
        for (const r of plan.routines) {
          await hevy(number, "/routines", { method: "POST", json: { routine: { title: r.title, folder_id: folderId, notes: r.notes ?? "", exercises: apiRoutineExercises(r.exercises) } } });
          done.push(r.title);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new HevyError(done.length ? `${done.join(", ")} sudah dibuat, tapi sisanya gagal: ${reason}` : reason);
      }
      return { text: `Rutinitas dibuat di Hevy: ${done.map((t) => `*${t}*`).join(", ")}${plan.folder ? ` (folder ${plan.folder.title})` : ""}. Mulai dari tab Workout di aplikasi Hevy.${madeText(made)}` };
    },
  }),
  writer({
    name: "hevy_update_routine",
    description: "Propose changing a routine. Read it with hevy_get_routine; exercises, if given, replace them all. Omit exercises to keep them.",
    schema: z.object({
      routine_id: z.string().min(1),
      title: z.string().min(1).max(100).optional(),
      notes: z.string().max(2000).optional(),
      exercises: z.array(routineExercise).min(1).max(40).optional(),
    }),
    async prepare(input, { number }) {
      const current = unwrap<Routine>(await hevy(number, `/routines/${encodeURIComponent(input.routine_id)}`), "routine");
      if (!current?.id) throw new Error(`There's no routine ${input.routine_id} in their Hevy.`);
      if (!input.title && input.notes === undefined && !input.exercises) throw new Error("Nothing to change.");
      const exercises = input.exercises ? await planExercises(number, input.exercises, true) : null;
      const plan: RoutineEdit = { routine_id: current.id, title: input.title ? line(input.title) : (current.title ?? "Routine"), notes: input.notes !== undefined ? input.notes.trim() || null : (current.notes ?? null), exercises };
      const preview = [
        "✏️ *Ubah rutinitas di Hevy*",
        `*${line(current.title ?? "")}*`,
        plan.title !== current.title && `Judul baru: *${plan.title}*`,
        input.notes !== undefined && `Catatan baru: _${line(plan.notes ?? "(kosong)")}_`,
        ...(exercises ? ["", "Latihan (menggantikan semua yang lama):", ...exerciseLines(exercises, true)] : []),
      ];
      return { preview: joinLines(preview), plan };
    },
    async apply(plan: RoutineEdit, { number }) {
      const made = plan.exercises ? await createMissing(number, plan.exercises) : [];
      const current = unwrap<Routine>(await hevy(number, `/routines/${encodeURIComponent(plan.routine_id)}`), "routine");
      if (!current?.id) throw new HevyError("That routine isn't in Hevy any more.");
      await hevy(number, `/routines/${encodeURIComponent(plan.routine_id)}`, {
        method: "PUT",
        json: { routine: { title: plan.title, notes: plan.notes, exercises: plan.exercises ? apiRoutineExercises(plan.exercises) : keepRoutineExercises(current) } },
      });
      return { text: `Rutinitas diubah di Hevy: *${plan.title}*.${madeText(made)}` };
    },
  }),
  writer({
    name: "hevy_log_measurements",
    description: "Propose recording body weight, body fat or body sizes in this person's Hevy for a day. Values already saved that day and not given are kept.",
    schema: z.object({
      date: day.optional().describe("Local day; default today."),
      weight_kg: z.number().min(20).max(400).optional(),
      weight_lb: z.number().min(44).max(880).optional().describe("Instead of weight_kg."),
      lean_mass_kg: z.number().min(10).max(300).optional(),
      fat_percent: z.number().min(1).max(75).optional(),
      neck_cm: cm,
      shoulder_cm: cm,
      chest_cm: cm,
      left_bicep_cm: cm,
      right_bicep_cm: cm,
      left_forearm_cm: cm,
      right_forearm_cm: cm,
      abdomen_cm: cm,
      waist_cm: cm,
      hips_cm: cm,
      left_thigh_cm: cm,
      right_thigh_cm: cm,
      left_calf_cm: cm,
      right_calf_cm: cm,
    }),
    async prepare(input, { number }) {
      const date = input.date ?? localDay();
      if (date > localDay()) throw new Error("That day is in the future.");
      if (input.weight_kg !== undefined && input.weight_lb !== undefined) throw new Error("Give weight_kg or weight_lb, not both.");
      const values: Partial<Record<MeasureKey, number>> = {};
      for (const k of MEASURE_KEYS) if (typeof input[k] === "number") values[k] = input[k];
      if (typeof input.weight_lb === "number") values.weight_kg = Math.round(input.weight_lb * LB * 100) / 100;
      if (Object.keys(values).length === 0) throw new Error("Give at least one measurement.");
      const existing = await measurementOn(number, date);
      const rows = (Object.keys(values) as MeasureKey[]).map((k) => {
        const [api, label, unit] = MEASURES[k];
        const before = existing?.[api];
        return `${label}: ${num(values[k]!, "id")} ${unit}${typeof before === "number" && before !== values[k] ? ` _(sebelumnya ${num(before, "id")} ${unit})_` : ""}`;
      });
      return { preview: ["📏 *Catat ukuran tubuh di Hevy*", dateText(date), "", ...rows].join("\n"), plan: { date, values } };
    },
    async apply(plan: { date: string; values: Partial<Record<MeasureKey, number>> }, { number }) {
      const fields = Object.fromEntries((Object.keys(plan.values) as MeasureKey[]).map((k) => [MEASURES[k][0], plan.values[k]]));
      const existing = await measurementOn(number, plan.date);
      // An edit replaces the whole day (and Hevy rejects explicit nulls), so it carries over what's already there.
      const merged = () => ({ ...Object.fromEntries(API_MEASURES.flatMap((k) => (typeof existing?.[k] === "number" ? [[k, existing[k]]] : []))), ...fields });
      if (existing) await hevy(number, `/body_measurements/${plan.date}`, { method: "PUT", json: merged() });
      else await hevy(number, "/body_measurements", { method: "POST", json: { date: plan.date, ...fields } });
      return { text: `Ukuran tubuh ${dateText(plan.date)} tersimpan di Hevy.` };
    },
  }),
];

const TOOLS: Tool[] = [...READERS, ...WRITERS];
const isWriter = (t: Tool): t is Writer => "prepare" in t;

function jsonSchema(schema: z.ZodObject) {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  return json as { type: "object"; [key: string]: unknown };
}

/** The tools for this chat: only in private, and only once this person connected Hevy. */
export function hevyTools(chat: ChatContext): BetaToolUnion[] {
  if (!hevyAllowed(chat) || !hevyAccount(chat.sender.number)) return [];
  return TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: jsonSchema(t.schema), eager_input_streaming: true }));
}

/** Runs a hevy_* tool. Returns undefined if `name` isn't one. */
export async function runHevyTool(name: string, input: unknown, chat: ChatContext, outbox: Outbox): Promise<string | undefined> {
  if (!name.startsWith("hevy_")) return undefined;
  if (!hevyAllowed(chat)) throw new Error("Hevy isn't available in this chat. It works in the person's private chat.");
  if (!hevyAccount(chat.sender.number)) throw new Error("This person hasn't connected Hevy. Ask them to send /hevy.");
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`No Hevy tool called ${name}.`);
  const parsed = tool.schema.parse(input);
  const ctx = { number: chat.sender.number, chatId: chat.chatId };
  return isWriter(tool) ? propose(tool, parsed, chat, outbox) : tool.read(parsed, ctx);
}

// --- Confirming changes --------------------------------------------------------------------------------------------

async function propose(tool: Writer, input: unknown, chat: ChatContext, outbox: Outbox): Promise<string> {
  const { preview, plan, warning } = await tool.prepare(input as never, { number: chat.sender.number, chatId: chat.chatId });
  const code = String(randomInt(1000, 10_000));
  db.prepare("INSERT INTO hevy_pending (chat_id, number, code, tool, plan, summary, status, noted, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?)").run(
    chat.chatId,
    chat.sender.number,
    code,
    tool.name,
    JSON.stringify(plan),
    preview,
    Date.now(),
  );
  await outbox.sendText(chat.chatId, `${preview}${warning ? `\n\n⚠️ ${warning}` : ""}\n\nBalas *YA ${code}* dalam ${CONFIRM_MINUTES} menit untuk menyimpan ke Hevy. Abaikan pesan ini untuk membatalkan.`);
  return (
    "Nothing is saved yet. They were sent this preview with a code, and it's saved only when they reply with that code. " +
    `Don't repeat the preview or the code, and don't say it's saved; mention anything you weren't sure about.${warning ? `\nWarning shown to them: ${warning}` : ""}\nPreview:\n${preview}`
  );
}

type Pending = { id: number; tool: string; plan: string; created_at: number };

/** Handles "YA 1234" for a pending Hevy change. True when the message was that (handled here, never shown to Claude). */
export async function confirmHevy(chat: ChatContext, text: string, outbox: Outbox): Promise<boolean> {
  const match = hevyAllowed(chat) ? CONFIRM.exec(text) : null;
  if (!match) return false;
  const pending = db
    .prepare("SELECT id, tool, plan, created_at FROM hevy_pending WHERE chat_id = ? AND number = ? AND code = ? AND status = 'pending' ORDER BY id DESC LIMIT 1")
    .get(chat.chatId, chat.sender.number, match[1]) as Pending | undefined;
  if (!pending) return false;
  const finish = (status: string, result: string) => db.prepare("UPDATE hevy_pending SET status = ?, result = ? WHERE id = ?").run(status, result, pending.id);
  if (Date.now() - pending.created_at > CONFIRM_MINUTES * 60_000) {
    finish("expired", "The confirmation code expired before it was used.");
    await outbox.sendText(chat.chatId, "Kode konfirmasi itu sudah kedaluwarsa, jadi belum ada yang tersimpan di Hevy. Minta ulang ke saya kalau masih perlu.");
    return true;
  }
  finish("running", "");
  await outbox.typing(chat.chatId);
  try {
    const tool = TOOLS.find((t) => t.name === pending.tool);
    if (!tool || !isWriter(tool)) throw new Error("That action no longer exists.");
    const result = await tool.apply(JSON.parse(pending.plan), { number: chat.sender.number, chatId: chat.chatId });
    finish("done", [result.text, result.detail].filter(Boolean).join(" — "));
    await outbox.sendText(chat.chatId, `✅ ${result.text}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finish("failed", message);
    await outbox.sendText(chat.chatId, `❌ Hevy tidak menyimpan itu: ${message}`);
  }
  return true;
}

/** What happened to changes Claude proposed in this chat since its last turn, so it knows on the next message. */
export function hevyNotes(chat: ChatContext): string | undefined {
  const rows = db
    .prepare("SELECT id, tool, summary, status, result FROM hevy_pending WHERE chat_id = ? AND noted = 0 AND status NOT IN ('pending', 'running')")
    .all(chat.chatId) as { id: number; tool: string; summary: string; status: string; result: string | null }[];
  if (rows.length === 0) return undefined;
  db.prepare(`UPDATE hevy_pending SET noted = 1 WHERE id IN (${rows.map(() => "?").join(",")})`).run(...rows.map((r) => r.id));
  const lines = rows.map((r) => `- ${r.tool} ("${r.summary.split("\n")[1] ?? r.summary.split("\n")[0]}"): ${r.status}${r.result ? ` — ${r.result}` : ""}`);
  return `[System note — Hevy changes you proposed earlier:\n${lines.join("\n")}]`;
}
