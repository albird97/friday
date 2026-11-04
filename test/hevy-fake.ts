import type { Template } from "../src/hevy.js";

// Hevy itself, faked: one account per API key, holding exercises, workouts, routines, folders and measurements.

export const KEYS = { sarah: "11111111-2222-4333-8444-555555555555", albert: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", revoked: "99999999-9999-4999-8999-999999999999" };

export const BUILT_IN: Template[] = [
  { id: "D04AC939", title: "Bench Press (Barbell)", type: "weight_reps", primary_muscle_group: "chest" },
  { id: "3601968B", title: "Bench Press (Dumbbell)", type: "weight_reps", primary_muscle_group: "chest" },
  { id: "6A6C31A5", title: "Lat Pulldown (Cable)", type: "weight_reps", primary_muscle_group: "lats" },
  { id: "1B2B1E7C", title: "Pull Up", type: "bodyweight_reps", primary_muscle_group: "lats" },
  { id: "ABCD0001", title: "Bicep Curl (Dumbbell)", type: "weight_reps", primary_muscle_group: "biceps" },
  { id: "C6272009", title: "Plank", type: "duration", primary_muscle_group: "abdominals" },
  { id: "RUN00001", title: "Running", type: "distance_duration", primary_muscle_group: "cardio" },
  // Enough of these that the exercise list takes two pages.
  ...Array.from({ length: 110 }, (_, i) => ({ id: `F${i}`, title: `Filler Move ${i} (Machine)`, type: "weight_reps", primary_muscle_group: "other" })),
];

type Account = { name: string; templates: Template[]; workouts: any[]; routines: any[]; folders: any[]; measurements: any[] };
type Call = { method: string; path: string; key: string | null; body: any };
/** What the fake Hevy holds, per API key, and every call made to it. */
export const hevyFake = { accounts: {} as Record<string, Account>, calls: [] as Call[] };
let nextId = 1;

/** Fresh accounts for the keys in KEYS (and any extra name → key pairs). */
export function resetHevy(extra: Record<string, string> = {}) {
  const account = (name: string): Account => ({ name, templates: [...BUILT_IN.map((t) => ({ ...t }))], workouts: [], routines: [], folders: [], measurements: [] });
  hevyFake.accounts = { [KEYS.sarah]: account("sarah_lifts"), [KEYS.albert]: account("albert"), ...Object.fromEntries(Object.entries(extra).map(([name, key]) => [key, account(name)])) };
  hevyFake.calls = [];
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const page = (items: unknown[], key: string, q: URLSearchParams, max: number) => {
  const size = Math.min(Number(q.get("pageSize") ?? 5), max);
  const n = Number(q.get("page") ?? 1);
  const count = Math.max(1, Math.ceil(items.length / size));
  if (n > count) return json({ error: "Page not found" }, 404);
  return json({ page: n, page_count: count, [key]: items.slice((n - 1) * size, n * size) });
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname !== "api.hevyapp.com") return realFetch(input, init);
  const method = init?.method ?? "GET";
  const key = new Headers(init?.headers).get("api-key");
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const path = url.pathname.replace(/^\/v1/, "");
  hevyFake.calls.push({ method, path, key, body });
  const a = key ? hevyFake.accounts[key] : undefined;
  if (!a) return json({ error: "Unauthorized" }, 401);
  const q = url.searchParams;
  const [, kind, id] = path.split("/");
  if (path === "/user/info") return json({ data: { id: "u1", name: a.name, url: `https://hevy.com/user/${a.name}` } });
  if (path === "/workouts/count") return json({ workout_count: a.workouts.length });
  if (kind === "exercise_templates" && method === "GET") return page(a.templates, "exercise_templates", q, 100);
  if (kind === "exercise_templates" && method === "POST") {
    const t = { id: `C${nextId++}`, title: body.exercise.title, type: body.exercise.exercise_type, primary_muscle_group: body.exercise.muscle_group, is_custom: true };
    a.templates.push(t);
    return json({ id: t.id });
  }
  const titled = (exercises: any[]) =>
    exercises.map((e: any, i: number) => ({ index: i, title: a.templates.find((t) => t.id === e.exercise_template_id)?.title, exercise_template_id: e.exercise_template_id, supersets_id: e.superset_id, notes: e.notes, rest_seconds: e.rest_seconds, sets: e.sets.map((s: any, j: number) => ({ index: j, ...s })) }));
  if (kind === "workouts" && !id && method === "GET") return page([...a.workouts].sort((x, y) => Date.parse(y.start_time) - Date.parse(x.start_time)), "workouts", q, 10);
  if (kind === "workouts" && method === "POST") {
    const w = { id: `w${nextId++}`, ...body.workout, exercises: titled(body.workout.exercises) };
    delete w.is_private; // Hevy never shows it back
    a.workouts.push(w);
    return json({ workout: [w] }, 201);
  }
  if (kind === "workouts" && id) {
    const i = a.workouts.findIndex((w) => w.id === id);
    if (i < 0) return json({ error: "Workout not found" }, 404);
    if (method === "PUT") {
      if (typeof body.workout.is_private !== "boolean") return json({ error: "is_private is required" }, 400);
      const { is_private: _hidden, ...rest } = body.workout;
      a.workouts[i] = { ...a.workouts[i], ...rest, exercises: titled(body.workout.exercises) };
      return json({ workout: [a.workouts[i]] });
    }
    return json(a.workouts[i]);
  }
  if (kind === "exercise_history") {
    const sets = a.workouts.flatMap((w) =>
      w.exercises.filter((e: any) => e.exercise_template_id === id).flatMap((e: any) => e.sets.map((s: any) => ({ workout_id: w.id, workout_title: w.title, workout_start_time: w.start_time, exercise_template_id: id, ...s, set_type: s.type }))),
    );
    return json({ exercise_history: sets });
  }
  if (kind === "routine_folders" && method === "GET") return page(a.folders, "routine_folders", q, 10);
  if (kind === "routine_folders" && method === "POST") {
    const f = { id: nextId++, title: body.routine_folder.title };
    a.folders.push(f);
    return json({ routine_folder: f }, 201);
  }
  if (kind === "routines" && !id && method === "GET") return page(a.routines, "routines", q, 10);
  if (kind === "routines" && method === "POST") {
    const r = { id: `r${nextId++}`, ...body.routine, exercises: titled(body.routine.exercises) };
    a.routines.push(r);
    return json({ routine: [r] }, 201);
  }
  if (kind === "routines" && id) {
    const i = a.routines.findIndex((r) => r.id === id);
    if (i < 0) return json({ error: "Routine not found" }, 404);
    if (method === "PUT") {
      if (body.routine.exercises.some((e: any) => e.sets.some((s: any) => "rep_range" in s && s.rep_range === null))) return json({ error: "rep_range must be an object" }, 400);
      a.routines[i] = { ...a.routines[i], ...body.routine, exercises: titled(body.routine.exercises) };
    }
    const { notes: _notShown, ...shown } = a.routines[i]; // Hevy's GET leaves a routine's notes out
    return json({ routine: shown });
  }
  if (kind === "body_measurements" && !id && method === "GET") return page(a.measurements, "body_measurements", q, 10);
  if (kind === "body_measurements" && method === "POST") {
    if (Object.values(body).some((v) => v === null)) return json({ error: "null not allowed" }, 400);
    a.measurements.push(body);
    return json({}, 201);
  }
  if (kind === "body_measurements" && id) {
    const i = a.measurements.findIndex((m) => m.date === id);
    if (i < 0) return json({ error: "Not found" }, 404);
    if (method === "PUT") a.measurements[i] = { date: id, ...body };
    return json(a.measurements[i]);
  }
  return json({ error: `fake Hevy has no ${method} ${path}` }, 404);
}) as typeof fetch;

