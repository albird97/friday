// Turns Smart Life on for the admin only (setup.ts's ADMIN), before any src module reads its configuration.
process.env.TUYA_ACCESS_ID = "tuya-id";
process.env.TUYA_ACCESS_SECRET = "tuya-secret";
process.env.TUYA_UID = "az-uid-1";
process.env.TUYA_REGION = "sg";
process.env.TUYA_USERS = "";

const { ADMIN, WIFE } = await import("./setup.js");
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
const { resetSmartlife, signature } = await import("../src/smartlife.js");
const { runTool, toolsFor } = await import("../src/tools.js");
import type { ChatContext, Outbox } from "../src/types.js";

const outbox: Outbox = { async sendText() {}, async sendFile() {}, async sendImage() {}, async typing() {}, chatIdFor: (n) => `${n}@s.whatsapp.net` };

// Fake Tuya cloud: it checks every signature the way Tuya's docs describe it, independently of src/smartlife.ts.
const HOST = "https://openapi-sg.iotbing.com";
type Call = { method: string; path: string; body: any };
let calls: Call[] = [];
let tokens = 0;
let validToken = "";
const DEVICES = [
  { id: "lamp1", name: "Lampu Teras", category: "dj", product_name: "Smart Bulb", online: true, local_key: "SECRETKEY1", status: [{ code: "switch_led", value: false }] },
  { id: "lamp2", name: "Lampu Kamar", category: "dj", product_name: "Smart Bulb", online: true, local_key: "SECRETKEY2", status: [{ code: "switch_led", value: true }] },
  { id: "plug1", name: "Colokan Dapur", category: "cz", online: false, local_key: "SECRETKEY3", status: [] },
  { id: "lock1", name: "Kunci Depan", category: "jtmspro", online: true, local_key: "SECRETKEY4", status: [{ code: "lock_motor_state", value: true }] },
];
const FUNCTIONS: Record<string, unknown[]> = {
  lamp1: [
    { code: "switch_led", type: "Boolean", values: "{}", name: "Switch" },
    { code: "bright_value_v2", type: "Integer", values: '{"min":10,"max":1000,"scale":0,"step":1}', name: "Brightness" },
  ],
  lamp2: [{ code: "switch_led", type: "Boolean", values: "{}" }],
  lock1: [{ code: "remote_unlock", type: "Boolean", values: "{}" }],
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const href = String(url);
  if (!href.startsWith(HOST)) return realFetch(url, init);
  const path = href.slice(HOST.length);
  const h = new Headers(init?.headers);
  const body = String(init?.body ?? "");
  const method = init?.method ?? "GET";
  const json = (result: unknown, ok = true, code?: number) => new Response(JSON.stringify(ok ? { success: true, result } : { success: false, code, msg: String(result) }));

  const token = h.get("access_token") ?? "";
  const toSign = `${method}\n${createHash("sha256").update(body).digest("hex")}\n\n${path}`;
  const expected = createHmac("sha256", "tuya-secret").update(`tuya-id${token}${h.get("t")}${h.get("nonce")}${toSign}`).digest("hex").toUpperCase();
  if (h.get("client_id") !== "tuya-id" || h.get("sign") !== expected || h.get("sign_method") !== "HMAC-SHA256") return json("sign invalid", false, 1004);

  if (path === "/v1.0/token?grant_type=1") {
    tokens++;
    validToken = `tok-${tokens}`;
    return json({ access_token: validToken, expire_time: 7200, refresh_token: "r", uid: "x" });
  }
  if (token !== validToken) return json("token invalid", false, 1010);
  calls.push({ method, path, body: body ? JSON.parse(body) : undefined });
  if (path === "/v1.0/users/az-uid-1/devices") return json(DEVICES);
  const fns = /^\/v1\.0\/devices\/(\w+)\/functions$/.exec(path);
  if (fns) return json({ category: "dj", functions: FUNCTIONS[fns[1]] ?? [] });
  if (/^\/v1\.0\/devices\/\w+\/commands$/.test(path)) return json(true);
  return json("not found", false, 1108);
}) as typeof fetch;

const dm = (who: { name: string; number: string }): ChatContext => ({ chatId: `${who.number}@s.whatsapp.net`, isGroup: false, chatName: who.name, sender: { ...who, isContact: true } });
const group: ChatContext = { chatId: "family@g.us", isGroup: true, chatName: "Family", sender: { ...ADMIN, isContact: true } };
const run = (name: string, input: unknown, chat = dm(ADMIN)) => runTool(name, input, { chat, outbox });
const commandsSent = () => calls.filter((c) => c.path.endsWith("/commands"));

beforeEach(() => {
  calls = [];
});

describe("Smart Life access", () => {
  it("offers its tools to the admin in a private chat only", async () => {
    const names = async (chat: ChatContext) => (await toolsFor(chat)).map((t) => (t as { name: string }).name).filter((n) => n.startsWith("smartlife_"));
    assert.deepEqual(await names(dm(ADMIN)), ["smartlife_devices", "smartlife_device", "smartlife_control"]);
    assert.deepEqual(await names(dm(WIFE)), []);
    assert.deepEqual(await names(group), []);
  });

  it("refuses its tools from a chat that isn't allowed", async () => {
    const result = await run("smartlife_control", { device: "Lampu Teras", commands: [{ code: "switch_led", value: true }] }, group);
    assert.equal(result.isError, true);
    assert.match(result.content, /isn't available/);
    assert.equal(calls.length, 0);
  });
});

describe("Smart Life devices", () => {
  it("lists devices with their state, never their local keys", async () => {
    const result = await run("smartlife_devices", {});
    assert.equal(result.isError, false);
    assert.match(result.content, /4 devices/);
    assert.match(result.content, /Lampu Teras \(Smart Bulb\) · id lamp1 · online · switch_led=false/);
    assert.match(result.content, /Colokan Dapur · id plug1 · OFFLINE/);
    assert.doesNotMatch(result.content, /SECRETKEY/);
    assert.match((await run("smartlife_devices", { search: "kamar" })).content, /^1 device:\n- Lampu Kamar/);
  });

  it("shows a device's controls", async () => {
    const result = await run("smartlife_device", { device: "teras" });
    assert.match(result.content, /bright_value_v2 \(Integer \{"min":10,"max":1000,"scale":0,"step":1\}\): Brightness/);
    assert.match((await run("smartlife_device", { device: "lampu" })).content, /could be: Lampu Teras, Lampu Kamar/);
    assert.match((await run("smartlife_device", { device: "kunci" })).content, /can't control it/);
  });

  it("sends commands to the device it names", async () => {
    const commands = [{ code: "switch_led", value: true }, { code: "bright_value_v2", value: 500 }];
    const result = await run("smartlife_control", { device: "Lampu Teras", commands });
    assert.equal(result.isError, false, result.content);
    assert.match(result.content, /Sent to Lampu Teras: switch_led=true, bright_value_v2=500/);
    assert.deepEqual(commandsSent(), [{ method: "POST", path: "/v1.0/devices/lamp1/commands", body: { commands } }]);
  });

  it("never controls locks, offline devices or controls a device doesn't have", async () => {
    const lock = await run("smartlife_control", { device: "Kunci Depan", commands: [{ code: "remote_unlock", value: true }] });
    assert.match(lock.content, /lock, door or gate/);
    const offline = await run("smartlife_control", { device: "Colokan", commands: [{ code: "switch_1", value: true }] });
    assert.match(offline.content, /offline/);
    const unknown = await run("smartlife_control", { device: "Lampu Kamar", commands: [{ code: "colour_data", value: "red" }] });
    assert.match(unknown.content, /no control colour_data/);
    assert.equal(commandsSent().length, 0);
  });

  it("reuses its token, and fetches a new one once Tuya stops accepting it", async () => {
    resetSmartlife();
    const before = tokens;
    await run("smartlife_devices", {});
    await run("smartlife_devices", {});
    assert.equal(tokens, before + 1);
    validToken = "rotated-elsewhere";
    assert.equal((await run("smartlife_devices", {})).isError, false);
    assert.equal(tokens, before + 2);
  });

  it("signs query parameters in key order", () => {
    assert.equal(signature("GET", "/v1.0/x?b=2&a=1", "", "1", "n"), signature("GET", "/v1.0/x?a=1&b=2", "", "1", "n"));
  });
});
