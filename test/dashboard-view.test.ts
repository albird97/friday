import "./setup.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderDashboard, renderLogin, renderMain, renderMessage } from "../src/admin/view.js";
import type { Snapshot, ViewContext } from "../src/admin/types.js";
import { sampleSnapshot } from "./dashboard-fixture.js";

// The dashboard's HTML: everything a person typed is escaped, private things stay private, and every state renders.

const asset = (file: string) => `/admin/assets/${file}?v=test`;
const ctx: ViewContext = { csrf: "csrf-token-123", range: 30, asset };
const EVIL = `<img src=x onerror="alert(1)">`;

/** Every `<script>` must load a file: the page's CSP forbids inline script. */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter(([, attrs, body]) => !/\bsrc=/.test(attrs) || body.trim()).map(([m]) => m);
}

describe("dashboard page", () => {
  it("renders every section with its anchor, and the csrf token in each form", () => {
    const html = renderDashboard(sampleSnapshot(), ctx);
    for (const id of ["ringkasan", "biaya", "aktivitas", "orang", "grup", "jadwal", "fitur", "sistem", "keamanan"]) {
      assert.match(html, new RegExp(`<section class="section" id="${id}"`), id);
      assert.match(html, new RegExp(`href="#${id}"`), `nav link to ${id}`);
    }
    const forms = html.match(/<form method="post"/g)!.length;
    const tokens = html.match(/<input type="hidden" name="csrf" value="csrf-token-123">/g)!.length;
    assert.equal(tokens, forms, "every POST form carries the token");
    assert.deepEqual(inlineScripts(html), []);
    assert.doesNotMatch(html, /\son[a-z]+="/i, "no inline event handlers");
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  });

  it("escapes names, group names, schedule text, log lines and browsers", () => {
    const s = sampleSnapshot();
    s.people[1].name = EVIL;
    s.groups[0].name = `Grup "${EVIL}"`;
    s.schedules.upcoming[0].text = EVIL;
    s.schedules.upcoming[0].where = EVIL;
    s.problems.unshift({ at: s.generatedAt, level: "error", text: EVIL });
    s.security.logins[0].agent = EVIL;
    s.security.sessions[0].ip = EVIL;
    s.accessRequests[0].name = EVIL;
    s.integrations.errands.recent[0].target = EVIL;
    s.costs.people[0].name = EVIL;
    s.daily.at(-1)!.topPeople[0].name = EVIL;
    const html = renderDashboard(s, ctx);
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  });

  it("shows someone else's private schedule without its text", () => {
    const html = renderMain(sampleSnapshot(), ctx);
    assert.match(html, /Pribadi milik Sarah/);
    assert.match(html, /Bayar listrik dan internet/, "the admin's own schedule is shown");
    assert.match(html, /Selamat pagi semua/, "a group's schedule is shown");
  });

  it("offers stop when running and resume when stopped, both as confirmed POSTs", () => {
    const running = renderMain(sampleSnapshot(), ctx);
    assert.match(running, /data-confirm-title="Hentikan Friday\?"[\s\S]*?name="action" value="stop"/);
    const stopped = sampleSnapshot();
    stopped.status.stopped = true;
    assert.match(renderMain(stopped, ctx), /name="action" value="resume"[\s\S]*?Nyalakan lagi/);
  });

  it("lets the admin wake a paused group and sign other browsers out", () => {
    const html = renderMain(sampleSnapshot(), ctx);
    assert.match(html, /name="action" value="wake"><input type="hidden" name="range" value="30"><input type="hidden" name="chat" value="120363000000000003@g.us">/);
    assert.match(html, /name="action" value="signOutOthers"/);
  });

  it("describes trouble in words, worst first", () => {
    const html = renderMain(sampleSnapshot({ trouble: true }), ctx);
    const order = ["WhatsApp terputus", "Claude gagal menjawab", "1 jadwal belum terkirim", "Biaya hari ini $21,40", "Backup terakhir", "2 orang minta akses"].map((t) => html.indexOf(t));
    assert.ok(order.every((at) => at > 0), `all present: ${order}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, "in severity order");
    assert.match(html, /5 hal perlu dicek/);
    assert.match(html, /health health-critical/);
  });

  it("renders a brand-new Friday with no data at all", () => {
    const html = renderDashboard(sampleSnapshot({ empty: true }), ctx);
    assert.match(html, /Semua berjalan normal/);
    assert.match(html, /Belum ada pemakaian dalam periode ini/);
    assert.match(html, /belum ada di grup mana pun/);
    assert.match(html, /Tidak ada jadwal aktif/);
    assert.doesNotMatch(html, /NaN|undefined|Infinity/);
  });

  it("never prints NaN, undefined or Infinity in any range", () => {
    for (const range of [7, 30, 90] as const) {
      for (const variant of [{}, { trouble: true }, { empty: true }]) {
        const html = renderMain(sampleSnapshot({ range, ...variant }), { ...ctx, range });
        assert.doesNotMatch(html, /NaN|undefined|Infinity|\[object /, `${range} ${JSON.stringify(variant)}`);
      }
    }
  });

  it("marks the chosen period and gives every chart a table", () => {
    const html = renderDashboard(sampleSnapshot({ range: 7 }), { ...ctx, range: 7 });
    assert.match(html, /data-range-link="7" aria-current="true"/);
    assert.doesNotMatch(html, /data-range-link="30" aria-current/);
    const charts = html.match(/data-chart tabindex="0"/g)!.length;
    assert.ok(charts >= 4);
    assert.ok(html.match(/<details class="tableview"/g)!.length >= 4, "table views for the charts");
  });

  it("shows a note after an action only on the full page", () => {
    const s = sampleSnapshot();
    assert.match(renderDashboard(s, { ...ctx, flash: "stopped" }), /data-toast[\s\S]*Friday dihentikan/);
    assert.doesNotMatch(renderDashboard(s, ctx), /data-toast/);
    assert.doesNotMatch(renderMain(s, { ...ctx, flash: "stopped" }), /data-toast/);
  });

  it("sends only the inside of <main> for the refresh", () => {
    const html = renderMain(sampleSnapshot(), ctx);
    assert.doesNotMatch(html, /<(html|head|body|main)\b/);
    assert.match(html, /^<div class="sections" data-generated="\d+" data-range="30" data-updated="[\d.]+">/);
  });

  it("formats money, time and counts the Indonesian way", () => {
    const s: Snapshot = sampleSnapshot();
    s.today.dollars = 1234.5;
    s.month.dollars = 0.003;
    const html = renderMain(s, ctx);
    assert.match(html, /\$1\.234,50/);
    assert.match(html, /≈ Rp20\.369\.250/);
    assert.match(html, /<p class="kpi-value">&lt;\$0,01<\/p>/);
    assert.match(html, /Diperbarui|data-updated="14\.42\.10"/);
  });
});

describe("sign-in page", () => {
  it("is a plain POST form with the right autocomplete hints", () => {
    const html = renderLogin({ asset });
    assert.match(html, /<form class="login-form" method="post" action="\/admin\/login"/);
    assert.match(html, /name="username" autocomplete="username"/);
    assert.match(html, /name="password" type="password" autocomplete="current-password"/);
    assert.doesNotMatch(html, /login-problem/);
    assert.deepEqual(inlineScripts(html), []);
  });

  it("says what went wrong, keeps the username, and escapes it", () => {
    assert.match(renderLogin({ problem: "wrong", username: "albert", asset }), /Username atau password salah[\s\S]*value="albert"/);
    assert.match(renderLogin({ problem: "blocked", retryAfterMs: 8 * 60_000, asset }), /Terlalu banyak percobaan\. Coba lagi dalam 8 menit\./);
    assert.match(renderLogin({ problem: "expired", asset }), /Sesi sudah berakhir/);
    assert.match(renderLogin({ problem: "origin", asset }), /ditolak demi keamanan/);
    const evil = renderLogin({ problem: "wrong", username: `"><script>alert(1)</script>`, asset });
    assert.doesNotMatch(evil, /<script>alert/);
    assert.match(evil, /value="&quot;&gt;&lt;script&gt;/);
  });

  it("explains how to switch the dashboard on when no login is set", () => {
    const html = renderLogin({ problem: "unconfigured", asset });
    assert.match(html, /Dashboard belum diaktifkan/);
    assert.match(html, /sudo \/opt\/friday\/app\/scripts\/linux-service\.sh admin/);
    assert.doesNotMatch(html, /<form/);
  });

  it("escapes plain messages", () => {
    const html = renderMessage(EVIL, EVIL, asset);
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /<title>&lt;img/);
  });
});
