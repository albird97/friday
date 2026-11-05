// Friday dashboard: refresh every 30 seconds, switch the period without a reload, tooltips for charts (mouse, touch and
// keyboard), section highlighting, table sorting, copy buttons, confirmation dialogs, the log filter and the theme
// button. Everything here is an extra: the page reads and works without it.
(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const REFRESH_MS = 30_000;

  // ── Theme ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const THEMES = ["system", "light", "dark"];
  const THEME_LABELS = { system: "Tema: ikut sistem", light: "Tema: terang", dark: "Tema: gelap" };
  const storedTheme = () => {
    try {
      const value = localStorage.getItem("friday-theme");
      return value === "light" || value === "dark" ? value : "system";
    } catch {
      return "system";
    }
  };
  function applyTheme(theme) {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    for (const button of $$("[data-theme-toggle]")) {
      button.dataset.mode = theme;
      button.setAttribute("aria-label", THEME_LABELS[theme]);
      button.title = THEME_LABELS[theme];
    }
  }
  applyTheme(storedTheme());
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-theme-toggle]");
    if (!button) return;
    const next = THEMES[(THEMES.indexOf(storedTheme()) + 1) % THEMES.length];
    try {
      if (next === "system") localStorage.removeItem("friday-theme");
      else localStorage.setItem("friday-theme", next);
    } catch {
      // not stored; still applies to this page
    }
    applyTheme(next);
  });

  // ── Sign-in page ──────────────────────────────────────────────────────────────────────────────────────────────
  const login = $("[data-login]");
  if (login) {
    const reveal = $("[data-reveal]", login);
    const password = $('input[name="password"]', login);
    reveal?.addEventListener("click", () => {
      const show = password.type === "password";
      password.type = show ? "text" : "password";
      reveal.setAttribute("aria-pressed", String(show));
      reveal.setAttribute("aria-label", show ? "Sembunyikan password" : "Tampilkan password");
      password.focus();
    });
    login.addEventListener("submit", () => {
      const submit = $("[data-submit]", login);
      if (!submit) return;
      submit.disabled = true;
      const label = $("span", submit);
      if (label) label.textContent = "Memeriksa…";
    });
  }

  // ── Copy buttons ──────────────────────────────────────────────────────────────────────────────────────────────
  async function copy(text, button) {
    const label = $("[data-copy-label]", button);
    const before = label?.textContent;
    try {
      await navigator.clipboard.writeText(text);
      if (label) label.textContent = "Tersalin";
    } catch {
      if (label) label.textContent = "Gagal menyalin";
    }
    setTimeout(() => label && before && (label.textContent = before), 1600);
  }
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-copy], [data-copy-log]");
    if (!button) return;
    if (button.hasAttribute("data-copy")) return void copy(button.dataset.copy, button);
    const log = button.closest("[data-log]");
    const lines = $$(".log-item", log)
      .filter((item) => item.offsetParent !== null)
      .map((item) => `${item.dataset.at} ${item.dataset.level.toUpperCase()} ${$(".log-text", item)?.textContent ?? ""}`);
    void copy(lines.join("\n"), button);
  });

  const main = $("#main");
  if (!main) return; // the sign-in and message pages stop here

  // ── Tooltips ──────────────────────────────────────────────────────────────────────────────────────────────────
  const tooltip = $("#tooltip");
  let tipped = null;

  function showTip(mark, x, y) {
    const lines = (mark.dataset.tip || "").split("\n").filter(Boolean);
    if (!tooltip || lines.length === 0) return;
    tipped?.classList.remove("is-active");
    tipped = mark;
    mark.classList.add("is-active");
    tooltip.replaceChildren(
      ...lines.map((line, i) => {
        const p = document.createElement("p");
        p.className = i === 0 ? "tip-head" : i === 1 ? "tip-value" : "tip-line";
        p.textContent = line; // names come from people: never innerHTML
        return p;
      }),
    );
    tooltip.hidden = false;
    const box = mark.getBoundingClientRect();
    const px = x ?? box.left + box.width / 2;
    const py = y ?? box.top;
    const { width, height } = tooltip.getBoundingClientRect();
    let left = px - width / 2;
    let top = py - height - 12;
    if (top < 8) top = (y ?? box.bottom) + 14;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
    tooltip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function hideTip() {
    tipped?.classList.remove("is-active");
    tipped = null;
    if (tooltip) tooltip.hidden = true;
  }

  document.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") return;
    const mark = event.target.closest?.("[data-tip]");
    if (mark) showTip(mark, event.clientX, event.clientY);
    else if (tipped) hideTip();
  });
  document.addEventListener("pointerleave", hideTip);
  document.addEventListener("click", (event) => {
    // A tap shows the tooltip of what was tapped; a tap elsewhere hides it.
    const mark = event.target.closest("[data-tip]");
    if (mark) showTip(mark, event.clientX || undefined, event.clientY || undefined);
    else hideTip();
  });
  window.addEventListener("scroll", hideTip, { passive: true });

  // Keyboard: focus a chart, then the arrow keys walk its marks.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") return hideTip();
    const chart = event.target.closest?.("[data-chart]");
    if (!chart || event.target !== chart) return;
    const marks = $$("[data-tip]", chart);
    if (marks.length === 0) return;
    const at = marks.indexOf(tipped);
    const steps = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    let next;
    if (event.key in steps) next = at < 0 ? (steps[event.key] > 0 ? 0 : marks.length - 1) : Math.max(0, Math.min(marks.length - 1, at + steps[event.key]));
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = marks.length - 1;
    else return;
    event.preventDefault();
    showTip(marks[next]);
  });
  document.addEventListener("focusout", (event) => {
    if (event.target.closest?.("[data-chart], .ranked-row[data-tip]")) hideTip();
  });
  document.addEventListener("focusin", (event) => {
    const row = event.target.closest?.(".ranked-row[data-tip]");
    if (row) showTip(row);
  });

  // ── Section highlighting in the sticky nav ───────────────────────────────────────────────────────────────────
  const navList = $(".secnav-list");
  const navLinks = new Map($$("[data-nav]").map((link) => [link.dataset.nav, link]));
  let observer;
  function setCurrent(id) {
    for (const [key, link] of navLinks) {
      if (key === id) {
        link.setAttribute("aria-current", "true");
        if (navList) {
          const left = link.offsetLeft - navList.clientWidth / 2 + link.clientWidth / 2;
          navList.scrollTo({ left, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        }
      } else link.removeAttribute("aria-current");
    }
  }
  function watchSections() {
    observer?.disconnect();
    if (!("IntersectionObserver" in window)) return;
    const visible = new Map();
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) visible.set(entry.target.id, entry.isIntersecting);
        if (atBottom()) return;
        const first = $$("[data-section]", main).find((section) => visible.get(section.id));
        if (first) setCurrent(first.id);
      },
      { rootMargin: "-80px 0px -55% 0px" },
    );
    for (const section of $$("[data-section]", main)) observer.observe(section);
  }
  // The last sections are too short to reach the top of the screen: at the very bottom, the last one is current.
  const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
  window.addEventListener(
    "scroll",
    () => {
      if (!atBottom()) return;
      const last = $$("[data-section]", main).at(-1);
      if (last) setCurrent(last.id);
    },
    { passive: true },
  );

  // ── Sortable tables ──────────────────────────────────────────────────────────────────────────────────────────
  const sortState = new Map(); // table index → { column, dir }
  function sortTable(table, column, dir) {
    const header = table.tHead.rows[0].cells[column];
    const numeric = header.dataset.sort === "num";
    const body = table.tBodies[0];
    const key = (row) => {
      const cell = row.cells[column];
      const value = cell?.dataset.value ?? cell?.textContent.trim() ?? "";
      return numeric ? Number(value) || 0 : value.toLowerCase();
    };
    const rows = Array.from(body.rows).sort((a, b) => {
      const [x, y] = [key(a), key(b)];
      const order = numeric ? x - y : String(x).localeCompare(String(y), "id");
      return dir === "ascending" ? order : -order;
    });
    body.append(...rows);
    for (const cell of table.tHead.rows[0].cells) cell.removeAttribute("aria-sort");
    header.setAttribute("aria-sort", dir);
  }
  function enhanceTables() {
    $$("table[data-sortable]", main).forEach((table, index) => {
      Array.from(table.tHead.rows[0].cells).forEach((cell, column) => {
        if (!cell.dataset.sort || cell.querySelector(".sort-btn")) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "sort-btn";
        button.append(...cell.childNodes);
        cell.append(button);
        button.addEventListener("click", () => {
          const current = sortState.get(index);
          const dir = current?.column === column && current.dir === "descending" ? "ascending" : "descending";
          sortState.set(index, { column, dir });
          sortTable(table, column, dir);
        });
      });
      const state = sortState.get(index);
      if (state) sortTable(table, state.column, state.dir);
    });
  }

  // ── Log filter ───────────────────────────────────────────────────────────────────────────────────────────────
  let logFilter = "all";
  function applyLogFilter() {
    const log = $("[data-log]", main);
    if (!log) return;
    log.dataset.filter = logFilter;
    for (const button of $$("[data-log-filter]", log)) button.setAttribute("aria-pressed", String(button.dataset.logFilter === logFilter));
  }
  main.addEventListener("click", (event) => {
    const button = event.target.closest("[data-log-filter]");
    if (!button) return;
    logFilter = button.dataset.logFilter;
    applyLogFilter();
  });

  // ── Confirmations ────────────────────────────────────────────────────────────────────────────────────────────
  const dialog = $("#confirm-dialog");

  /**
   * Posts a copy of the form's fields. The original may be gone by the time the person confirms: the 30-second refresh
   * replaces the page's content, and a browser won't submit a form that's no longer in the page.
   */
  function submitCopy(action, fields) {
    const copy = document.createElement("form");
    copy.method = "post";
    copy.action = action;
    copy.hidden = true;
    for (const [name, value] of fields) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      copy.append(input);
    }
    document.body.append(copy);
    copy.submit();
  }

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!form.dataset.confirmTitle) return;
    event.preventDefault();
    const action = form.getAttribute("action");
    const fields = Array.from(new FormData(form).entries());
    if (!dialog?.showModal) {
      if (window.confirm(`${form.dataset.confirmTitle}\n\n${form.dataset.confirmText ?? ""}`)) submitCopy(action, fields);
      return;
    }
    $("[data-confirm-title]", dialog).textContent = form.dataset.confirmTitle;
    $("[data-confirm-text]", dialog).textContent = form.dataset.confirmText ?? "";
    $("[data-confirm-ok]", dialog).textContent = form.dataset.confirmOk ?? "Ya";
    dialog.returnValue = "";
    dialog.addEventListener(
      "close",
      () => {
        if (dialog.returnValue === "ok") submitCopy(action, fields);
        else schedule();
      },
      { once: true },
    );
    dialog.showModal();
    $("[data-confirm-ok]", dialog).focus();
  });

  // ── Toast after an action ────────────────────────────────────────────────────────────────────────────────────
  const toast = $("[data-toast]");
  if (toast) {
    const close = () => {
      toast.classList.add("is-leaving");
      setTimeout(() => toast.remove(), 320);
    };
    $("[data-toast-close]", toast)?.addEventListener("click", close);
    setTimeout(close, 6000);
    const url = new URL(location.href);
    url.searchParams.delete("done");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }

  // ── Refresh and period ───────────────────────────────────────────────────────────────────────────────────────
  const refreshBox = $("[data-refresh]");
  const refreshText = $("[data-refresh-text]");
  let range = Number($(".sections", main)?.dataset.range) || 30;
  let lastRefresh = Date.now();
  let timer;
  let busy = false;
  let queued; // a period picked while a refresh was running

  function markRange(value) {
    for (const link of $$("[data-range-link]")) {
      if (Number(link.dataset.rangeLink) === value) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    }
  }

  function setRefreshState(state, text) {
    refreshBox?.classList.toggle("is-loading", state === "loading");
    refreshBox?.classList.toggle("is-error", state === "error");
    if (text && refreshText) refreshText.textContent = text;
  }

  function swap(html) {
    const open = new Set($$("details[data-keep][open]", main).map((details) => details.dataset.keep));
    const template = document.createElement("template");
    template.innerHTML = html; // our own server's markup for this page, same as the first load
    document.documentElement.dataset.refreshed = "1";
    hideTip();
    main.replaceChildren(template.content);
    for (const details of $$("details[data-keep]", main)) if (open.has(details.dataset.keep)) details.open = true;
    enhanceTables();
    applyLogFilter();
    watchSections();
  }

  async function refresh(nextRange = range) {
    if (busy) {
      if (nextRange !== range) queued = nextRange;
      return;
    }
    busy = true;
    clearTimeout(timer);
    const sections = $(".sections", main);
    if (nextRange !== range) sections?.classList.add("is-stale");
    setRefreshState("loading");
    try {
      const response = await fetch(`/admin?range=${nextRange}&partial=1`, { credentials: "same-origin", cache: "no-store", headers: { Accept: "text/html" } });
      if (response.status === 401) {
        location.href = "/admin/login?expired=1";
        return;
      }
      if (!response.ok) throw new Error(String(response.status));
      swap(await response.text());
      range = nextRange;
      lastRefresh = Date.now();
      const updated = $(".sections", main)?.dataset.updated;
      setRefreshState("ok", updated ? `Diperbarui ${updated}` : undefined);
    } catch {
      sections?.classList.remove("is-stale");
      markRange(range);
      setRefreshState("error", "Gagal memperbarui");
    } finally {
      busy = false;
      if (queued !== undefined) {
        const next = queued;
        queued = undefined;
        void refresh(next);
      } else schedule();
    }
  }

  // The timed refresh waits while someone is mid-action: a confirmation open, or keyboard focus on something in the
  // page that the refresh would replace. It waits three rounds at most, so a forgotten focus can't freeze the page.
  let deferred = 0;
  function busyHere() {
    if (dialog?.open) return true;
    const focused = document.activeElement;
    return Boolean(focused && focused !== main && main.contains(focused) && deferred < 3);
  }

  function schedule() {
    clearTimeout(timer);
    if (document.visibilityState !== "visible") return;
    timer = setTimeout(() => {
      if (busyHere()) {
        deferred++;
        return schedule();
      }
      deferred = 0;
      void refresh();
    }, REFRESH_MS);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return clearTimeout(timer);
    if (Date.now() - lastRefresh > REFRESH_MS) void refresh();
    else schedule();
  });
  $("[data-refresh-now]")?.addEventListener("click", () => void refresh());

  for (const link of $$("[data-range-link]")) {
    link.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      const next = Number(link.dataset.rangeLink);
      markRange(next);
      const url = new URL(location.href);
      url.searchParams.set("range", String(next));
      url.searchParams.delete("done");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
      void refresh(next);
    });
  }

  enhanceTables();
  applyLogFilter();
  watchSections();
  schedule();
})();
