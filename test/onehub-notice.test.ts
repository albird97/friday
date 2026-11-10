import "./onehub-env.js";
import { ADMIN, WIFE } from "./setup.js";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { deliverOnehubNotice } from "../src/onehub.js";
import type { Outbox } from "../src/types.js";

let sent: { chatId: string; text: string }[] = [];
let files: { chatId: string; fileName: string; mimetype: string; caption?: string; data: string }[] = [];
const outbox: Outbox = {
  async sendText(chatId, text) {
    sent.push({ chatId, text });
  },
  async sendFile(chatId, file) {
    files.push({ chatId, fileName: file.fileName, mimetype: file.mimetype, caption: file.caption, data: file.data.toString("utf8") });
  },
  async sendImage() {},
  async typing() {},
  chatIdFor: (n) => `${n}@s.whatsapp.net`,
};

const auth = { authorization: "Bearer test-onehub-token" };
const body = (to: string[], text = "🟠 2 chat Shopee hampir lewat 12 jam") => JSON.stringify({ to, text });

describe("notices from onehub", () => {
  beforeEach(() => {
    sent = [];
    files = [];
  });

  it("sends the text word for word to a person in ONEHUB_USERS, by name or number", async () => {
    const byName = await deliverOnehubNotice(auth, body([ADMIN.name.toLowerCase()]), outbox);
    assert.equal(byName.status, 200);
    assert.deepEqual(sent, [{ chatId: `${ADMIN.number}@s.whatsapp.net`, text: "🟠 2 chat Shopee hampir lewat 12 jam" }]);

    sent = [];
    const byNumber = await deliverOnehubNotice(auth, body([`+${ADMIN.number}`, ADMIN.name]), outbox);
    assert.equal(byNumber.status, 200);
    assert.equal(sent.length, 1, "the same person twice gets it once");
  });

  it("never messages someone outside ONEHUB_USERS", async () => {
    const answer = await deliverOnehubNotice(auth, body([WIFE.name, "Nobody"]), outbox);
    assert.equal(answer.status, 422);
    assert.deepEqual(answer.body.skipped, [WIFE.name, "Nobody"]);
    assert.equal(sent.length, 0);

    const mixed = await deliverOnehubNotice(auth, body([WIFE.name, ADMIN.name]), outbox);
    assert.equal(mixed.status, 200);
    assert.deepEqual(mixed.body.sent, [ADMIN.name]);
    assert.equal(sent.length, 1);
  });

  it("refuses a wrong token, a request through nginx, and a malformed body", async () => {
    assert.equal((await deliverOnehubNotice({ authorization: "Bearer nope" }, body([ADMIN.name]), outbox)).status, 401);
    assert.equal((await deliverOnehubNotice({}, body([ADMIN.name]), outbox)).status, 401);
    assert.equal((await deliverOnehubNotice({ ...auth, "x-forwarded-proto": "https" }, body([ADMIN.name]), outbox)).status, 404);
    assert.equal((await deliverOnehubNotice(auth, "not json", outbox)).status, 422);
    assert.equal((await deliverOnehubNotice(auth, body([ADMIN.name], "  "), outbox)).status, 422);
    assert.equal(sent.length, 0);
  });

  it("posts into a group listed in ONEHUB_NOTICE_GROUPS, and into no other group", async () => {
    const answer = await deliverOnehubNotice(auth, body(["gudang@g.us", "lain@g.us"], "📦 Serah terima SPX"), outbox);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { sent: ["gudang@g.us"], skipped: ["lain@g.us"] });
    assert.deepEqual(sent, [{ chatId: "gudang@g.us", text: "📦 Serah terima SPX" }]);

    sent = [];
    assert.equal((await deliverOnehubNotice(auth, body(["lain@g.us"]), outbox)).status, 422);
    assert.equal(sent.length, 0);
  });

  it("sends a file as a document with the text as its caption", async () => {
    const file = { file_name: "Serah Terima ST-261110/003.pdf", mimetype: "application/pdf", data: Buffer.from("%PDF-1.7 isi").toString("base64") };
    const answer = await deliverOnehubNotice(auth, JSON.stringify({ to: ["gudang@g.us"], text: "📦 90 paket", file }), outbox);
    assert.equal(answer.status, 200);
    assert.deepEqual(files, [
      { chatId: "gudang@g.us", fileName: "Serah Terima ST-261110-003.pdf", mimetype: "application/pdf", caption: "📦 90 paket", data: "%PDF-1.7 isi" },
    ]);
    assert.equal(sent.length, 0, "one message, not a text and then a file");
  });

  it("refuses a file that isn't base64 or has no proper type", async () => {
    const withFile = (file: unknown) => JSON.stringify({ to: ["gudang@g.us"], text: "x", file });
    assert.equal((await deliverOnehubNotice(auth, withFile({ file_name: "a.pdf", mimetype: "application/pdf", data: "bukan base64!" }), outbox)).status, 422);
    assert.equal((await deliverOnehubNotice(auth, withFile({ file_name: "a.pdf", mimetype: "pdf", data: "QQ==" }), outbox)).status, 422);
    assert.equal(files.length + sent.length, 0);
  });
});
