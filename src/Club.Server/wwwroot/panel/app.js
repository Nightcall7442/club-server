// Панель клуба: «Зал», «Игры», «Windows», «Сеть». Без сборки и внешних зависимостей —
// панель работает в клубе без интернета (шрифты лежат в fonts/).
(() => {
  "use strict";

  const API = "/panel/api/v1";
  const REFRESH_MS = 5000;
  const VIEWS = ["machines", "library", "images", "network"];
  const LANGS = ["ru", "uz", "en"];
  const $ = (id) => document.getElementById(id);

  let lang = safeGet(localStorage, "panel.lang") || "ru";
  let token = safeGet(sessionStorage, "panel.token");
  let data = null;
  let dataJson = "";
  let timer = null;
  let editing = null;
  let view = "machines";
  let selectedId = null;
  let net = null;
  let netJson = "";
  let netSettings = null;
  let formDirty = false;
  let imgs = null;
  let imgsJson = "";
  let reimaging = null;
  let lib = null;
  let libJson = "";
  let libHistory = null;
  let lastOk = 0;
  let lastFail = false;
  const openContents = new Set();
  const filters = { text: "", status: safeGet(localStorage, "panel.filter") || "all" };
  const NET_FIELDS = ["subnet", "interface", "dhcpServer", "gateway", "dnsServers", "poolStart", "poolEnd", "reservedStart", "leaseTimeSec", "keaSubnetId"];

  function safeGet(storage, key) {
    try { return storage.getItem(key); } catch { return null; }
  }

  function safeSet(storage, key, value) {
    try { value === null ? storage.removeItem(key) : storage.setItem(key, value); } catch { /* приватный режим */ }
  }

  function t(key, vars) {
    const text = (window.I18N[lang] && window.I18N[lang][key]) ?? window.I18N.ru[key] ?? key;
    return vars ? text.replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? "") : text;
  }

  const has = (key) => t(key) !== key;

  function applyStaticTexts() {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach((node) => { node.textContent = t(node.dataset.i18n); });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => { node.placeholder = t(node.dataset.i18nPlaceholder); });
    document.querySelectorAll("[data-i18n-label]").forEach((node) => { node.setAttribute("aria-label", t(node.dataset.i18nLabel)); });
    document.querySelectorAll("[data-i18n-title]").forEach((node) => {
      node.title = t(node.dataset.i18nTitle);
      node.setAttribute("aria-label", node.title);
    });
    document.querySelectorAll("[data-lang]").forEach((select) => { select.value = lang; });
    $("lang").textContent = lang.toUpperCase();
    document.title = t("brandShort");
    renderHeader();
  }

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const child of children.flat()) {
      if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  const SVG = "http://www.w3.org/2000/svg";
  function icon(name, cls) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("class", `i${cls ? ` ${cls}` : ""}`);
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(SVG, "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function button(label, opts = {}) {
    const { cls = "", ico, onclick, title, type = "button", disabled } = opts;
    return el("button", { type, class: `btn ${cls}`.trim(), onclick, title, disabled }, ico ? icon(ico) : null, label ? el("span", {}, label) : null);
  }

  function iconButton(ico, title, onclick, cls = "") {
    return el("button", { type: "button", class: `icon-btn sm ring ${cls}`.trim(), title, "aria-label": title, onclick }, icon(ico));
  }

  // Прочерк вместо отсутствующего или невменяемого значения (сервер уже отбросил невозможные).
  const dash = () => el("span", { class: "dash" }, "—");
  const orDash = (value, mono) => (value === null || value === undefined || value === "" ? dash() : el("span", { class: mono ? "mono" : "" }, value));
  const pad = (n) => String(n).padStart(2, "0");

  async function api(path, options = {}) {
    const response = await fetch(API + path, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(options.headers || {}) },
    });
    if (response.status === 401) {
      logout();
      throw new Error("unauthorized");
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const error = new Error(body?.error?.message || `HTTP ${response.status}`);
      error.reason = body?.error?.details?.reason;
      error.details = body?.error?.details;
      throw error;
    }
    return response.status === 204 ? null : response.json().catch(() => null);
  }

  function markOk() { lastOk = Date.now(); lastFail = false; renderLive(); }
  function markFail() { lastFail = true; renderLive(); }

  function agoText(iso) {
    const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    return seconds < 60 ? t("agoSeconds", { n: seconds })
      : seconds < 3600 ? t("agoMinutes", { n: Math.floor(seconds / 60) })
      : seconds < 86400 ? t("agoHours", { n: Math.floor(seconds / 3600) })
      : t("agoDays", { n: Math.floor(seconds / 86400) });
  }

  // Относительное время обновляется на месте, без перерисовки: кнопки под курсором не пересоздаются.
  function ago(iso) {
    if (!iso) return dash();
    return el("span", { title: new Date(iso).toLocaleString(lang), "data-ago": iso }, agoText(iso));
  }

  function refreshAgo() {
    document.querySelectorAll("[data-ago]").forEach((node) => { node.textContent = agoText(node.dataset.ago); });
    renderLive();
  }

  function clock() {
    const d = new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function renderLive() {
    $("live").classList.toggle("stale", lastFail);
    $("live-text").textContent = lastFail ? t("liveStale") : `${t("liveOk")} · ${clock()}`;
  }

  // ---------- Уведомления и подтверждения ----------

  function toast(text, kind = "ok") {
    const ico = { ok: "check", bad: "alert", info: "info" }[kind] || "info";
    const node = el("div", { class: `toast glass dock ${kind}`, role: kind === "bad" ? "alert" : "status" },
      el("span", { class: "sign" }, icon(ico)), el("span", {}, text),
      el("button", { type: "button", class: "icon-btn sm", "aria-label": t("close"), onclick: () => dismiss() }, icon("x")));
    const dismiss = () => {
      node.classList.add("out");
      setTimeout(() => node.remove(), 200);
    };
    $("toasts").append(node);
    setTimeout(dismiss, kind === "bad" ? 9000 : 4000);
  }

  // Своё окно вместо confirm(): тот же смысл, но в стиле панели и с понятной главной кнопкой.
  function ask(text, opts = {}) {
    const { title = t("confirmTitle"), ok = t("confirmOk"), danger = false } = opts;
    const dialog = $("confirm");
    $("confirm-title").textContent = title;
    $("confirm-text").textContent = text;
    $("confirm-yes").textContent = ok;
    $("confirm-yes").className = `btn ${danger ? "danger" : "primary"}`;
    $("confirm-sign").className = `sign${danger ? " bad" : ""}`;
    $("confirm-sign").replaceChildren(icon(danger ? "alert" : "info"));
    return new Promise((resolve) => {
      const onClose = () => {
        dialog.removeEventListener("close", onClose);
        resolve(dialog.returnValue === "yes");
      };
      dialog.returnValue = "";
      dialog.addEventListener("close", onClose);
      dialog.showModal();
      $("confirm-yes").focus();
    });
  }

  const anyDialogOpen = () => [...document.querySelectorAll("dialog")].some((d) => d.open);

  // ---------- Статусы ----------

  const STATUS = {
    online: ["ok", "online"],
    offline: ["bad", "offline"],
    neverSeen: ["idle", "neverSeen"],
    pendingApproval: ["warn", "pendingApproval"],
    maintenance: ["info", "maintenanceStatus"],
    reimaging: ["warn", "reimaging"],
  };
  const REIMAGE = { requested: "info", deploying: "warn", failed: "bad", booting: "info", done: "ok", cancelled: "idle" };
  const VOLUME = {
    none: ["idle", "volNone"],
    mounting: ["info", "volMounting"],
    mounted: ["ok", "volMounted"],
    switchPending: ["warn", "volSwitchPending"],
    failed: ["bad", "volFailed"],
  };

  function badge(kind, text, title, extra = "") {
    return el("span", { class: `badge ${kind} ${extra}`.trim(), title: title || null }, text);
  }

  function volumeBadges(volume) {
    const [kind, key] = VOLUME[volume.state] || ["idle", volume.state];
    const badges = [badge(kind, volume.libraryVersion ? `${volume.libraryVersion} · ${t(key)}` : t(key), volume.error || "")];
    if (volume.outdated) badges.push(badge("warn", t("volOutdated")));
    if (volume.state === "mounted" && volume.readOnlyVerified !== true) badges.push(badge("bad", t("volNotVerified")));
    return el("div", { class: "badges" }, badges);
  }

  function reimageText(r) {
    let text = t(`rs_${r.state}`);
    if (r.state === "deploying" && r.step) text += ` · ${t(`st_${r.step}`)}${r.percent !== null && r.percent !== undefined ? ` ${r.percent}%` : ""}`;
    if (r.state === "failed" && r.failure) text += ` · ${has(`fr_${r.failure}`) ? t(`fr_${r.failure}`) : t(`st_${r.failure}`)}`;
    if (r.attempts > 1) text += ` (#${r.attempts})`;
    return text;
  }

  function sbBadges(sb) {
    if (!sb || sb.enabled === null || sb.enabled === undefined) return dash();
    const title = `db: CA 2011 ${sb.thirdPartyCa2011 ? "✓" : "✗"}, CA 2023 ${sb.windowsCa2023 ? "✓" : "✗"}; dbx: PCA 2011 ${sb.pca2011Revoked ? "✗" : "—"}`;
    const list = [badge(sb.enabled ? "ok" : "idle", t(sb.enabled ? "sbOn" : "sbOff"), title)];
    if (sb.enabled && sb.thirdPartyCa2011 === false) list.push(badge("bad", t("sbNoCa2011"), title));
    if (sb.enabled && sb.pca2011Revoked) list.push(badge("info", t("sbRevoked"), title));
    return el("div", { class: "badges" }, list);
  }

  // Одно состояние места для плитки и окна места: тон, короткая подпись, история, заливка.
  function seatState(m) {
    const r = m.reimage;
    const v = m.volume || {};
    const sb = m.secureBoot;
    const activeReimage = r && ["requested", "deploying", "failed", "booting"].includes(r.state);
    if (activeReimage) {
      const percent = r.state === "deploying" && r.percent !== null && r.percent !== undefined ? r.percent : null;
      const step = r.step ? t(`st_${r.step}`) : "";
      return {
        tone: REIMAGE[r.state],
        short: r.state === "deploying" ? t("tile_deploying", { p: percent !== null ? `${percent}%` : step }) : t(`tile_${r.state}`),
        story: t(`sty_${r.state}`, { step, reason: r.failure ? (has(`fr_${r.failure}`) ? t(`fr_${r.failure}`) : t(`st_${r.failure}`)) : r.message || "" }),
        level: percent,
      };
    }
    if (m.status === "offline") return { tone: "bad", short: t("tile_offline"), story: t("sty_offline", { ago: m.lastSeenAt ? agoText(m.lastSeenAt) : "—" }), hollow: true };
    if (m.status === "neverSeen") return { tone: "idle", short: t("tile_neverSeen"), story: t("sty_neverSeen"), hollow: true };
    if (m.status === "maintenance") return { tone: "info", short: t("tile_maintenance"), story: t("sty_maintenance") };
    if (v.state === "failed") return { tone: "bad", short: t("tile_volFailed"), story: t("sty_volFailed", { error: v.error || "" }) };
    if (v.state === "switchPending") return { tone: "warn", short: t("tile_switchPending"), story: t("sty_switchPending", { version: data?.currentLibraryVersion || "" }) };
    if (v.state === "mounted" && v.readOnlyVerified !== true) return { tone: "bad", short: t("tile_notVerified"), story: t("sty_notVerified") };
    if (sb?.enabled && sb.thirdPartyCa2011 === false) return { tone: "warn", short: t("tile_noCa"), story: t("sty_noCa") };
    if (v.outdated) return { tone: "warn", short: t("tile_outdated"), story: t("sty_outdated") };
    if (v.state === "mounting") return { tone: "info", short: t("tile_mounting"), story: t("sty_mounting") };
    if (v.state !== "mounted") return { tone: "warn", short: t("tile_noVolume"), story: t("sty_noVolume") };
    return { tone: "ok", short: t("tile_ok"), story: t("sty_ok", { lib: v.libraryVersion || "—", image: m.imageVersion || "—" }) };
  }

  function needsAttention(m) {
    const s = seatState(m);
    return s.tone === "bad" || s.tone === "warn" || m.status === "neverSeen";
  }

  const FILTERS = {
    all: () => true,
    attention: needsAttention,
    offline: (m) => m.status === "offline" || m.status === "neverSeen",
    service: (m) => m.status === "maintenance" || m.status === "reimaging",
  };

  function zoneName(id) {
    return data?.zones.find((z) => z.id === id)?.name ?? id;
  }

  // ---------- Зал ----------

  // Дата словами. Для узбекского в браузерах часто нет данных локали — берём названия из переводов.
  function dateLine(d) {
    const own = window.I18N[lang]?.weekdays;
    if (own) return t("dateFormat", { weekday: own[d.getDay()], day: d.getDate(), month: window.I18N[lang].months[d.getMonth()] });
    return d.toLocaleDateString(lang, { weekday: "long", day: "numeric", month: "long" });
  }

  function shiftName() {
    const h = new Date().getHours();
    return t(h < 6 ? "shiftNight" : h < 12 ? "shiftMorning" : h < 18 ? "shiftDay" : "shiftEvening");
  }

  function setFilter(status) {
    filters.status = status;
    safeSet(localStorage, "panel.filter", status);
    renderFloor();
  }

  function seated() {
    return data ? data.machines.filter((m) => m.status !== "pendingApproval") : [];
  }

  function renderHero() {
    const all = seated();
    $("hall-shift").textContent = `${shiftName()} · ${dateLine(new Date())}`;
    $("hall-zones").textContent = t("zonesCount", { n: data.zones.length || 1 });
    $("hero-n").textContent = data.online;
    $("hero-of").textContent = `/${all.length}`;
    // Самое важное — коротко: не больше трёх пунктов по убыванию срочности.
    const silent = all.filter((m) => m.status === "offline" || m.status === "neverSeen").length;
    const attention = all.filter((m) => m.status === "online" && needsAttention(m)).length;
    const parts = [
      [silent, "hp_offline"], [data.reimaging, "hp_reimaging"], [attention, "hp_attention"], [data.pending, "hp_pending"], [data.maintenance, "hp_maintenance"],
    ].filter(([n]) => n > 0).slice(0, 3).map(([n, key]) => t(key, { n }));
    const line = parts.length ? `${parts.join(", ")}.` : all.length ? t("hp_allGood") : t("hp_empty");
    $("hero-line").textContent = line.charAt(0).toUpperCase() + line.slice(1);
  }

  function renderFilters() {
    const list = seated();
    $("m-filter").replaceChildren(...Object.keys(FILTERS).map((key) => el("button", {
      type: "button", class: filters.status === key ? "active" : "", "aria-pressed": filters.status === key ? "true" : "false", onclick: () => setFilter(key),
    }, t(`flt_${key}`), el("b", {}, list.filter(FILTERS[key]).length))));
    $("m-admit").hidden = !data?.pending;
    $("m-admit-n").textContent = data?.pending || "";
  }

  function matches(m) {
    const q = filters.text.trim().toLowerCase();
    return (FILTERS[filters.status] || FILTERS.all)(m)
      && (!q || [String(m.number), m.name, m.hostname, m.ipAddress, ...(m.macAddresses || []), m.helperVersion].some((v) => v && String(v).toLowerCase().includes(q)));
  }

  function tile(m) {
    const s = seatState(m);
    const on = m.id === selectedId;
    const glow = el("span", { class: `glow${s.level !== null && s.level !== undefined ? " level" : ""}`, "aria-hidden": "true" });
    if (s.level !== null && s.level !== undefined) glow.style.setProperty("--level", `${s.level}%`);
    return el("button", {
      type: "button",
      class: `tile tone-${s.tone}${s.hollow ? " hollow" : ""}${on ? " on" : ""}${matches(m) ? "" : " dim"}`,
      "aria-pressed": on ? "true" : "false",
      "aria-label": `${t("seat")} ${m.number}, ${m.name}: ${s.short}`,
      onclick: () => { selectedId = m.id; renderFloor(); renderInspector(); },
    },
    glow,
    el("span", { class: "tile-top" }, el("span", { class: "mono" }, pad(m.number)), el("span", { class: "tile-dot" })),
    el("span", { class: "tile-name" }, el("b", { title: m.name }, m.name), el("span", {}, s.short)));
  }

  function renderFloor() {
    if (!data) return;
    renderFilters();
    const all = seated();
    $("empty").hidden = all.length > 0;
    $("m-nomatch").hidden = all.length === 0 || all.some(matches);
    const zoneIds = [...new Set([...data.zones.map((z) => z.id), ...all.map((m) => m.zone)])];
    const groups = zoneIds.map((id) => ({ id, machines: all.filter((m) => m.zone === id).sort((a, b) => a.number - b.number) })).filter((g) => g.machines.length);
    const biggest = Math.max(0, ...groups.map((g) => g.machines.length));
    $("floor").replaceChildren(...groups.map((g) => {
      const nums = g.machines.map((m) => m.number);
      const isVip = /vip/i.test(g.id) || /vip/i.test(zoneName(g.id));
      return el("div", { class: `zone${g.machines.length === biggest && groups.length > 1 ? " wide" : ""}${isVip ? " vip" : ""}` },
        el("div", { class: "zone-head caps" }, el("span", {}, zoneName(g.id)), el("span", { class: "mono" }, `${pad(Math.min(...nums))}–${pad(Math.max(...nums))}`)),
        el("div", { class: "tiles" }, g.machines.map(tile)));
    }));
  }

  function renderInspector() {
    const box = $("inspector");
    const m = seated().find((x) => x.id === selectedId);
    box.style.removeProperty("--tone");
    if (!m) {
      box.className = "inspector glass bright panel";
      box.replaceChildren(el("div", { class: "insp-empty" }, el("p", {}, t("inspEmpty"))));
      return;
    }
    const s = seatState(m);
    box.className = `inspector glass bright panel tone-${s.tone}`;
    const r = m.reimage;
    const canCancel = r && ["requested", "failed"].includes(r.state) && !r.diskTouched;
    const canReimage = !r || !["requested", "deploying", "failed", "booting"].includes(r.state) || r.state === "booting" || r.state === "failed";
    const progress = s.level !== null && s.level !== undefined
      ? el("div", { class: "well progress-box" },
        el("div", { class: "gauge", style: { "--p": `${s.level}%` } }, el("span", { class: "arc" }), el("b", {}, `${s.level}%`)),
        el("div", {}, el("b", {}, t(`st_${r.step || "download"}`)), el("span", { class: "small muted" }, reimageText(r))))
      : null;
    const prop = (label, value) => el("div", {}, el("dt", {}, label), el("dd", {}, value));
    box.replaceChildren(...[
      el("span", { class: "halo", "aria-hidden": "true" }),
      el("div", { class: "insp-head" },
        el("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
          el("span", { class: "eyebrow" }, `${t("seat")} · ${zoneName(m.zone)}`),
          el("span", { class: "insp-no" }, pad(m.number))),
        el("span", { class: `pill${s.hollow ? " hollow" : ""}` }, s.short)),
      el("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
        el("span", { class: "insp-name" }, m.name),
        el("p", { class: "lead" }, s.story)),
      progress,
      el("dl", { class: "props" },
        prop(t("inspLib"), volumeBadges(m.volume)),
        prop(t("inspWin"), el("div", { class: "cell-stack", style: { alignItems: "flex-end" } }, orDash(m.imageVersion, true),
          m.masterState ? badge(m.masterState === "failed" ? "bad" : "warn", t("masterBadge", { letter: "M" }), t(`mm_${m.masterState}`)) : null,
          r && !progress ? badge(REIMAGE[r.state] || "idle", reimageText(r), r.message || "") : null)),
        prop("Secure Boot", sbBadges(m.secureBoot)),
        prop(t("inspIp"), orDash(m.ipAddress, true)),
        prop("MAC", m.macAddresses.length ? el("span", { class: "mono" }, m.macAddresses.join(", ")) : dash()),
        prop(t("inspHost"), orDash(m.hostname, true)),
        prop(t("inspHelper"), orDash(m.helperVersion, true)),
        prop(t("inspSeen"), ago(m.lastSeenAt))),
      el("div", { class: "insp-actions" },
        button(t("edit"), { cls: "primary", ico: "edit", onclick: () => openEdit(m) }),
        canReimage ? button(t("reimage"), { ico: "reimage", onclick: () => openReimage(m) }) : null,
        canCancel ? button(t("reimageCancel"), { cls: "danger-ghost", ico: "x", onclick: async () => {
          if (await ask(t("reimageConfirmCancel", { name: m.name }), { danger: true, ok: t("reimageCancel") })) act(`/machines/${m.id}/reimage/cancel`);
        } }) : null)].filter(Boolean));
  }

  function renderPending() {
    const pending = data.machines.filter((m) => m.status === "pendingApproval");
    const box = $("pending");
    box.hidden = pending.length === 0;
    if (!pending.length) return;
    box.replaceChildren(
      el("span", { class: "eyebrow", style: { color: "var(--peach-2)" } }, t("doorEyebrow")),
      el("div", { class: "door-title" }, t("doorTitle", { n: pending.length })),
      el("div", { class: "door-list", style: { marginTop: "auto" } }, pending.map((m) => el("div", {},
        el("div", { class: "who" }, el("b", {}, m.hostname),
          el("span", {}, m.macAddresses.length ? `${m.macAddresses[0]} · ` : "", m.ipAddress ? `${m.ipAddress} · ` : "", ago(m.registeredAt))),
        button(t("admit"), { cls: "peach sm", onclick: () => act(`/machines/${m.id}/approve`, t("approved", { name: m.hostname })) }),
        iconButton("x", t("reject"), async () => {
          if (await ask(t("rejectConfirm", { name: m.hostname }), { danger: true, ok: t("reject") })) act(`/machines/${m.id}/reject`);
        }, "danger")))));
  }

  function renderWidgets() {
    const all = seated();
    const lv = data.currentLibraryVersion;
    const onCurrent = all.filter((m) => m.volume?.state === "mounted" && m.volume.libraryVersion === lv).length;
    const switching = all.filter((m) => m.volume?.state === "switchPending").length;
    const online = all.filter((m) => m.status === "online");
    const segs = online.map((m) => {
      const v = m.volume || {};
      return v.state === "mounted" && v.libraryVersion === lv ? "ok" : v.state === "switchPending" ? "warn" : v.state === "failed" ? "bad" : v.state === "mounted" ? "info" : "idle";
    }).sort((a, b) => ["ok", "info", "warn", "bad", "idle"].indexOf(a) - ["ok", "info", "warn", "bad", "idle"].indexOf(b));
    $("w-games").replaceChildren(
      el("div", { class: "panel-head" }, el("span", { class: "eyebrow" }, t("wGames")), el("a", { href: "#library", class: "small" }, t("wOpen"))),
      el("div", { class: lv ? "big" : "big none" }, lv || t("noVersion")),
      el("p", { class: "lead" }, lv ? t("wGamesLine", { n: onCurrent, s: switching }) : t("libEmpty")),
      segs.length ? el("div", { class: "seg-bar", role: "img", "aria-label": t("libOnlineOf", { n: online.length }) }, segs.map((k) => el("span", { class: `tone-${k}` }))) : null,
      el("a", { class: "link-pill", href: "#library" }, el("span", {}, t("wGamesLink")), el("span", { "aria-hidden": "true" }, icon("arrow", "sm"))));
    const iv = data.currentImageVersion;
    const reimagingNow = all.filter((m) => m.reimage && ["requested", "deploying", "booting"].includes(m.reimage.state)).length;
    $("w-windows").replaceChildren(
      el("div", { class: "panel-head" }, el("span", { class: "eyebrow" }, t("wWindows")), el("a", { href: "#images", class: "small" }, t("wOpen"))),
      el("div", { class: iv ? "big" : "big none" }, iv || t("noVersion")),
      el("p", { class: "lead" }, iv ? (reimagingNow ? t("wWindowsBusy", { n: reimagingNow }) : t("wWindowsIdle")) : t("imgEmpty")),
      el("a", { class: "link-pill", href: "#images" }, el("span", {}, t("wWindowsLink")), el("span", { "aria-hidden": "true" }, icon("arrow", "sm"))));
  }

  function renderNavCounters() {
    const setCount = (id, n, kind) => {
      const node = $(id);
      node.hidden = !n;
      node.textContent = n || "";
      node.className = `nav-count${kind ? ` ${kind}` : ""}`;
    };
    if (data) setCount("nav-machines", data.pending, "");
    if (lib) setCount("nav-library", lib.warnings.length || lib.openOperations.length, lib.warnings.length ? "" : "info");
    if (imgs) setCount("nav-images", imgs.warnings.length, "");
    if (net) setCount("nav-network", net.foreignDhcp.length || net.warnings.length, net.foreignDhcp.length ? "bad" : "");
  }

  function render() {
    if (!data) return;
    const all = seated();
    if (!all.some((m) => m.id === selectedId)) selectedId = (all.find(needsAttention) || all[0])?.id ?? null;
    renderNavCounters();
    renderHero();
    renderFloor();
    renderInspector();
    renderPending();
    renderWidgets();
  }

  // ---------- Сеть ----------

  // Красная плашка на любом экране: чужой DHCP раздаёт адреса в сети клуба.
  function renderDhcpAlert() {
    const foreign = net?.foreignDhcp ?? [];
    $("dhcp-alert").hidden = foreign.length === 0;
    $("dhcp-alert").replaceChildren(...foreign.map((f) => el("p", {}, icon("alert"), el("span", {}, t("dhcpAlert", { server: f.server, machines: f.seenBy.join(", ") })))));
  }

  function warningText(w) {
    const key = `warn_${w.kind}`;
    const text = t(key, { subject: w.subject });
    return text === key ? w.message : text;
  }

  function warningItems(list) {
    return list.map((w) => el("li", { title: w.message }, el("span", {}, warningText(w)), el("span", { class: "muted" }, ago(w.lastSeen))));
  }

  function renderNetSummary() {
    const chips = [];
    if (!net.keaEnabled) chips.push(badge("idle", t("keaOff")));
    else if (!net.sync) chips.push(badge("idle", t("keaNever")));
    else if (net.sync.error) chips.push(badge("bad", t("keaUnavailable"), net.sync.error));
    else if (!net.sync.schemaOk) chips.push(badge("bad", t("keaSchemaBad", { v: net.sync.schemaVersion ?? "—" })));
    else chips.push(badge("ok", t("keaSchema", { v: net.sync.schemaVersion })));
    if (net.sync?.at) chips.push(el("span", { class: "chip" }, icon("refresh", "sm"), `${t("keaSynced")}: `, ago(net.sync.at)));
    $("net-summary").replaceChildren(...chips);
  }

  function renderNetwork() {
    if (!net) return;
    renderDhcpAlert();
    renderNavCounters();
    if (view !== "network") return;
    renderNetSummary();
    $("net-unconfigured").hidden = net.configured;
    $("net-warnings").hidden = net.warnings.length === 0;
    $("net-warning-list").replaceChildren(...warningItems(net.warnings));
    $("net-res-count").textContent = net.reservations.length;
    $("net-empty").hidden = net.reservations.length > 0;
    $("net-rows").replaceChildren(...net.reservations.map((r) => el("tr", {},
      el("td", {}, el("span", { class: "seat-mini" }, pad(r.seat))),
      el("td", {}, r.name),
      el("td", { class: "mono" }, orDash(r.mac, true)),
      el("td", { class: "mono" }, orDash(r.ip, true)),
      el("td", { class: "mono" }, orDash(r.hostname, true)),
      el("td", {}, r.problem ? badge("warn", t(`problem_${r.problem}`)) : badge("ok", t("resOk"))))));
  }

  function renderCapacity() {
    if (!netSettings) return;
    $("net-capacity").textContent = t("netCapacity", { n: netSettings.seatCapacity, start: netSettings.reservedStart });
  }

  function clearFieldErrors(form) {
    form.querySelectorAll(".field-error").forEach((node) => node.remove());
    form.querySelectorAll(".input.invalid").forEach((node) => node.classList.remove("invalid"));
  }

  function fillForm(s) {
    const form = $("net-form");
    for (const name of NET_FIELDS) {
      const value = name === "dnsServers" ? s.dnsServers.join(", ") : name === "leaseTimeSec" ? Math.round(s.leaseTimeSec / 60) : s[name];
      form.elements[name].value = value ?? "";
    }
    clearFieldErrors(form);
    $("net-interfaces").replaceChildren(...(s.serverInterfaces ?? []).map((name) => el("option", { value: name })));
    formDirty = false;
    renderCapacity();
  }

  function showError(id, error) {
    $(id).textContent = t("loadFailed", { error: error.message });
    $(id).hidden = false;
    markFail();
  }

  async function loadSettings(force) {
    if (formDirty && !force) return;
    try {
      netSettings = await api("/network/settings");
      fillForm(netSettings);
    } catch (error) {
      if (error.message === "unauthorized") return;
      showError("net-error", error);
    }
  }

  async function loadNetwork() {
    try {
      const fresh = await api("/network/status");
      const json = JSON.stringify(fresh);
      $("net-error").hidden = true;
      if (json !== netJson) {
        net = fresh;
        netJson = json;
        renderNetwork();
      }
    } catch (error) {
      if (error.message === "unauthorized") return;
      if (view === "network") showError("net-error", error);
    }
  }

  async function saveNetwork(event) {
    event.preventDefault();
    const form = $("net-form");
    const value = (name) => form.elements[name].value.trim();
    const body = {
      subnet: value("subnet"),
      interface: value("interface"),
      dhcpServer: value("dhcpServer"),
      gateway: value("gateway"),
      dnsServers: value("dnsServers").split(/[\s,;]+/).filter(Boolean),
      poolStart: value("poolStart"),
      poolEnd: value("poolEnd"),
      reservedStart: value("reservedStart"),
      leaseTimeSec: Math.round(Number(value("leaseTimeSec")) * 60),
      keaSubnetId: Number(value("keaSubnetId")),
    };
    clearFieldErrors(form);
    $("net-form-error").hidden = true;
    $("net-saved").hidden = true;
    $("net-save").disabled = true;
    try {
      netSettings = await api("/network/settings", { method: "PUT", body: JSON.stringify(body) });
      fillForm(netSettings);
      $("net-saved").hidden = false;
      toast(t("netSaved"));
      netJson = "";
      await loadNetwork();
    } catch (error) {
      const errors = error.details?.errors ?? (error.details?.field ? [error.details] : []);
      let shown = 0;
      for (const e of errors) {
        const input = form.elements[e.field];
        if (!input) continue;
        shown++;
        input.classList.add("invalid");
        input.after(el("span", { class: "field-error" }, t(`reason_${e.reason}`)));
      }
      if (shown === 0) {
        $("net-form-error").textContent = error.message;
        $("net-form-error").hidden = false;
      } else {
        form.querySelector(".input.invalid")?.focus();
      }
    } finally {
      $("net-save").disabled = false;
    }
  }

  async function downloadConfig() {
    $("net-form-error").hidden = true;
    try {
      const response = await fetch(API + "/network/kea-dhcp4.conf", { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error?.details?.reason === "notConfigured" ? t("netUnconfigured") : body?.error?.message || `HTTP ${response.status}`);
      }
      const url = URL.createObjectURL(await response.blob());
      const link = el("a", { href: url, download: "kea-dhcp4.conf" });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      $("net-form-error").textContent = error.message;
      $("net-form-error").hidden = false;
    }
  }

  // ---------- Перезаливка ----------

  function problemText(error) {
    const key = `re_${error.reason}`;
    return error.reason && has(key) ? t(key) : error.message;
  }

  async function openReimage(machine) {
    reimaging = machine;
    $("reimage-name").textContent = `${t("seat")} ${pad(machine.number)} · ${machine.name}`;
    $("reimage-new-disk").checked = false;
    $("reimage-error").hidden = true;
    let overview = imgs;
    try { overview = await api("/images"); } catch { /* покажем то, что есть */ }
    const options = [];
    if (overview?.current) options.push(el("option", { value: overview.current }, `${overview.current} (${t("imgCurrent")})`));
    if (overview?.rollback) options.push(el("option", { value: overview.rollback }, `${overview.rollback} (${t("imgRollback")})`));
    $("reimage-image").replaceChildren(...options);
    $("reimage-start").disabled = options.length === 0;
    if (options.length === 0) {
      $("reimage-error").textContent = t("re_noImage");
      $("reimage-error").hidden = false;
    }
    $("reimage").showModal();
  }

  async function startReimage(event) {
    event.preventDefault();
    $("reimage-start").disabled = true;
    try {
      await api(`/machines/${reimaging.id}/reimage`, {
        method: "POST",
        body: JSON.stringify({ image: $("reimage-image").value, allowNewDisk: $("reimage-new-disk").checked }),
      });
      $("reimage").close();
      toast(t("reimageStarted", { name: reimaging.name }));
      dataJson = "";
      await load();
    } catch (error) {
      $("reimage-error").textContent = problemText(error);
      $("reimage-error").hidden = false;
    } finally {
      $("reimage-start").disabled = false;
    }
  }

  // ---------- Игры ----------

  const LIB_STATE = { publishing: "info", published: "ok", retiring: "idle", retired: "idle", failed: "bad" };
  const OP_STATUS = { pending: "idle", running: "info", done: "ok", failed: "bad" };
  const PUBLISH_STEPS = ["snapshot", "clone", "extent", "target", "promote"];
  const MASTER_OPEN_STEPS = ["auth", "initiator", "extent", "target"];
  const MASTER_CLOSE_STEPS = ["target", "extent", "initiator", "auth"];

  function suggestLabel() {
    const d = new Date();
    const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const taken = new Set((lib?.versions ?? []).map((v) => v.label));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }

  // Карточка «текущая / откатная версия» — общая для игр и Windows.
  function versionHero(opts) {
    const { title, current, lead, meta, rollback, onRollback, rollbackLabel } = opts;
    return [
      el("span", { class: "eyebrow" }, title),
      el("div", { class: current ? "big" : "big none" }, current || t("noVersion")),
      lead ? el("p", { class: "lead" }, lead) : null,
      meta && meta.length ? el("div", { class: "badges" }, meta) : null,
      el("div", { class: "rollback well" },
        el("div", {}, el("span", { class: "small muted" }, t("rollbackVersion")), rollback ? el("b", {}, rollback) : dash()),
        rollback ? button(rollbackLabel, { cls: "sm", ico: "undo", onclick: onRollback }) : null),
    ];
  }

  function renderAdoption() {
    const a = lib.machines;
    if (!a || a.online === 0) {
      $("lib-adoption").replaceChildren(el("p", { class: "lead" }, t("libNoOnline")));
      return;
    }
    const tones = { onCurrent: "ok", onOlder: "info", switchPending: "warn", failed: "bad", notMounted: "idle" };
    const parts = Object.keys(tones).filter((key) => a[key] > 0);
    const segs = parts.flatMap((key) => Array.from({ length: a[key] }, () => tones[key]));
    const pct = Math.round((100 * (a.onCurrent || 0)) / a.online);
    $("lib-adoption").replaceChildren(el("div", { style: { display: "flex", flexDirection: "column", gap: "20px" } },
      el("div", { style: { display: "flex", alignItems: "baseline", gap: "12px" } }, el("span", { class: "big" }, `${pct}%`), el("span", { class: "muted" }, t("ad_onCurrent"))),
      el("div", { class: "seg-bar" }, segs.map((k) => el("span", { class: `tone-${k}` }))),
      el("div", { class: "legend" },
        parts.map((key) => el("div", { class: `tone-${tones[key]}` }, el("i"), el("span", {}, t(`ad_${key}`)), el("b", {}, a[key]))))));
  }

  function stepper(steps, at, failed) {
    return el("div", { class: "stepper" }, steps.map((step, i) => {
      const state = i < at ? "done" : i === at ? (failed ? "failed" : "active") : "";
      return el("div", { class: `stp ${state}` },
        el("span", { class: "dot" }, state === "done" ? icon("check") : state === "failed" ? icon("x") : String(i + 1)),
        el("span", {}, t(`step_${step}`)));
    }));
  }

  function renderOperation(op) {
    const steps = { publish: PUBLISH_STEPS, masterOpen: MASTER_OPEN_STEPS, masterClose: MASTER_CLOSE_STEPS }[op.kind] ?? ["promote"];
    const at = op.status === "done" ? steps.length : Math.max(0, steps.indexOf(op.step ?? steps[0]));
    return el("div", { class: "op well", style: { flex: "1 1 420px" } },
      el("div", { class: "op-head" },
        el("div", {}, el("b", {}, t(`op_${op.kind}`)), op.versionLabel ? el("span", { class: "mono" }, op.versionLabel) : null,
          badge(OP_STATUS[op.status] || "idle", t(`os_${op.status}`)), op.attempts > 1 ? el("span", { class: "small muted" }, `#${op.attempts}`) : null,
          el("span", { class: "small muted" }, ago(op.updatedAt || op.createdAt))),
        op.status === "failed" ? button(t("libRetry"), { cls: "primary sm", ico: "refresh", onclick: () => libAct(`/library/operations/${op.id}/retry`) }) : null),
      stepper(steps, at, op.status === "failed"),
      op.lastError ? el("div", { class: "op-error" }, op.lastError) : null);
  }

  const MASTER_STATE = { closed: "idle", opening: "info", open: "warn", closing: "info", failed: "bad" };
  const MASTER_MACHINE = { mounted: "ok", mounting: "info", failed: "bad", none: "idle" };

  function renderMaster() {
    const m = lib.master;
    const box = $("lib-master");
    const isOpen = !!m && m.state !== "closed";
    $("lib-master-card").className = `glass panel${isOpen ? " warm" : ""}`;
    if (!m) { box.replaceChildren(); return; }
    const parts = [];
    if (m.state !== "closed") {
      parts.push(el("div", { class: "master-status well" },
        m.driveLetter ? el("span", { class: "drive" }, `${m.driveLetter}:`) : null,
        el("div", { class: "who" },
          m.machineName ? el("b", {}, t("masterOnPc", { name: m.machineName, letter: m.driveLetter })) : null,
          m.openedAt && m.state === "open" ? el("span", { class: "small muted" }, `${t("masterSince")} `, ago(m.openedAt)) : null),
        el("div", { class: "badges" },
          badge(MASTER_STATE[m.state] || "idle", t(`ms_${m.state}`)),
          m.state === "open" ? badge(MASTER_MACHINE[m.machineState ?? "none"] || "idle", t(`mm_${m.machineState ?? "none"}`)) : null)));
    }
    if (m.state === "closing") parts.push(el("p", { class: "hint" }, t("masterWaiting")));
    if (m.lastError && m.state !== "open") parts.push(el("p", { class: "form-error" }, m.lastError));
    if (m.dirty && m.state === "closed") parts.push(el("p", { class: "banner warn" }, icon("alert"), el("span", {}, t("masterDirty"))));

    const actions = [];
    if (m.state === "closed") {
      const candidates = lib.masterCandidates ?? [];
      if (candidates.length === 0) {
        parts.push(el("p", { class: "hint" }, t("masterNoCandidates")));
      } else {
        const select = el("select", { class: "select", "aria-label": t("masterPc") }, candidates.map((c) =>
          el("option", { value: c.id }, `${pad(c.number)} · ${c.name}${c.online ? ` · ${t("online")}` : ""}`)));
        actions.push(select, button(t("masterOpen"), { cls: "lilac", ico: "unlock", onclick: () => libAct("/library/master/open", { machineId: select.value }) }));
      }
    }
    if (m.state === "open") actions.push(button(t("masterFinish"), { cls: "primary", ico: "check", onclick: () => libAct("/library/master/close", {}) }));
    if (m.state === "failed") actions.push(button(t("masterCleanup"), { ico: "x", onclick: () => libAct("/library/master/close", {}) }));
    if ((m.state === "open" || m.state === "closing") && !m.forceClose) {
      actions.push(button(t("masterForce"), { cls: "danger-ghost", ico: "alert", onclick: async () => {
        if (await ask(t("masterForceConfirm"), { danger: true, ok: t("masterForce") })) libAct("/library/master/close", { force: true });
      } }));
    }
    if (actions.length) parts.push(el("div", { class: "master-row" }, actions));
    box.replaceChildren(el("div", { style: { display: "flex", flexDirection: "column", gap: "16px" } }, parts));

    const blocked = m.state !== "closed";
    $("lib-publish-button").disabled = blocked;
    $("lib-publish-button").title = blocked ? t("masterBlocksPublish") : "";
  }

  function contentsCell(v) {
    if (!v.contents) return el("td", { class: "muted", title: t("libContentsHint") }, v.state === "published" ? t("libNoContents") : "");
    const details = el("details", { title: t("libContentsHint") },
      el("summary", {}, icon("chevron"), t("libFolders", { n: v.contents.length })),
      el("div", { class: "folders" }, v.contents.map((name) => el("span", { class: "folder" }, name))));
    details.open = openContents.has(v.label);
    details.addEventListener("toggle", () => { if (details.open) openContents.add(v.label); else openContents.delete(v.label); });
    return el("td", { class: "wrap" }, details);
  }

  function renderLibrary() {
    if (!lib) return;
    renderNavCounters();
    if (view !== "library") return;
    $("lib-disabled").hidden = lib.storageEnabled;

    $("lib-summary").replaceChildren(...versionHero({
      title: t("libCurrentVersion"),
      current: lib.current?.label,
      lead: lib.current ? t("libHeroLine", { n: lib.current.mountedOn || 0 }) : t("libEmpty"),
      meta: lib.current?.publishedAt ? [el("span", { class: "chip" }, `${t("libColPublished")}: `, ago(lib.current.publishedAt))] : null,
      rollback: lib.rollback?.label,
      rollbackLabel: t("libRollback"),
      onRollback: async () => {
        if (await ask(t("libRollbackConfirm", { label: lib.rollback.label }), { ok: t("libRollback") })) libAct("/library/rollback");
      },
    }));

    $("lib-warnings").hidden = lib.warnings.length === 0;
    $("lib-warning-list").replaceChildren(...warningItems(lib.warnings));

    renderAdoption();
    renderMaster();
    if (!$("lib-label").value || $("lib-label").dataset.auto === "1") {
      $("lib-label").value = suggestLabel();
      $("lib-label").dataset.auto = "1";
    }

    $("lib-ops").hidden = lib.openOperations.length === 0;
    $("lib-op-list").replaceChildren(...lib.openOperations.map(renderOperation));

    const visible = lib.versions.filter((v) => v.state !== "retired").concat(lib.versions.filter((v) => v.state === "retired").slice(0, 5));
    $("lib-empty").hidden = visible.length > 0;
    $("lib-rows").replaceChildren(...visible.map((v) => {
      const badges = [badge(LIB_STATE[v.state] || "idle", t(`ls_${v.state}`), v.lastError || "")];
      if (v.role) badges.push(badge(v.role === "current" ? "accent" : "info", t(v.role === "current" ? "imgCurrent" : "imgRollback"), null, "solid"));
      return el("tr", { class: v.state === "retired" ? "retired" : "" },
        el("td", { class: "mono" }, v.label),
        el("td", {}, el("div", { class: "cell-stack" }, el("div", { class: "badges" }, badges), v.lastError ? el("span", { class: "field-error" }, v.lastError) : null)),
        el("td", {}, v.mountedOn ? el("span", { class: "seat-mini" }, v.mountedOn) : dash()),
        contentsCell(v),
        el("td", { class: "muted" }, v.publishedAt ? ago(v.publishedAt) : dash()),
        el("td", { class: "mono muted" }, orDash(v.targetIqn, true)));
    }));

    if (libHistory) {
      $("lib-history").replaceChildren(...libHistory.map((op) => el("tr", {},
        el("td", { class: "muted" }, ago(op.createdAt)),
        el("td", {}, t(`op_${op.kind}`)),
        el("td", { class: "mono" }, orDash(op.versionLabel, true)),
        el("td", {}, el("div", { class: "badges" }, badge(OP_STATUS[op.status] || "idle", t(`os_${op.status}`), op.lastError || ""),
          op.step && op.status !== "done" ? el("span", { class: "small muted" }, t(`step_${op.step}`)) : null)),
        el("td", { class: "mono" }, op.attempts),
        el("td", {}, op.status === "failed" ? el("div", { class: "row-actions" }, button(t("libRetry"), { cls: "sm", ico: "refresh", onclick: () => libAct(`/library/operations/${op.id}/retry`) })) : null))));
    }
  }

  async function loadLibrary() {
    try {
      const [fresh, history] = await Promise.all([api("/library"), api("/library/operations?limit=15")]);
      const json = JSON.stringify([fresh, history]);
      $("lib-error").hidden = true;
      markOk();
      if (json !== libJson) {
        lib = fresh;
        libHistory = history;
        libJson = json;
        renderLibrary();
      }
    } catch (error) {
      if (error.message === "unauthorized") return;
      showError("lib-error", error);
    }
  }

  async function libAct(path, body, okText) {
    try {
      await api(path, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
      toast(okText || t("actionQueued"));
    } catch (error) {
      toast(problemText(error), "bad");
    }
    libJson = "";
    await loadLibrary();
  }

  async function publishLibrary(event) {
    event.preventDefault();
    const label = $("lib-label").value.trim();
    $("lib-publish-error").hidden = true;
    const dirty = lib?.master?.dirty === true;
    if (!await ask(t(dirty ? "libPublishDirtyConfirm" : "libPublishConfirm", { label }), { ok: t("imgPublish"), danger: dirty })) return;
    $("lib-publish-button").disabled = true;
    try {
      await api("/library/versions", { method: "POST", body: JSON.stringify({ label, allowDirtyMaster: dirty }) });
      toast(t("libPublishStarted", { label }));
      $("lib-label").value = "";
      $("lib-label").dataset.auto = "1";
      libJson = "";
      await loadLibrary();
    } catch (error) {
      const key = `reason_${error.reason}`;
      $("lib-publish-error").textContent = error.reason === "format" ? t("libLabelHint") : has(key) ? t(key) : error.message;
      $("lib-publish-error").hidden = false;
    } finally {
      $("lib-publish-button").disabled = lib?.master ? lib.master.state !== "closed" : false;
    }
  }

  // ---------- Windows ----------

  const IMAGE_STATE = { importing: "info", ready: "ok", failed: "bad" };

  function size(bytes) {
    if (bytes === null || bytes === undefined) return dash();
    if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GiB`;
    return bytes >= 1 << 20 ? `${Math.round(bytes / (1 << 20))} MiB` : `${Math.max(1, Math.round(bytes / 1024))} KiB`;
  }

  function renderImages() {
    if (!imgs) return;
    renderNavCounters();
    if (view !== "images") return;
    $("img-disabled").hidden = imgs.enabled;
    const current = imgs.images.find((i) => i.label === imgs.current);
    $("img-summary").replaceChildren(...versionHero({
      title: t("imgCurrentVersion"),
      current: imgs.current,
      lead: current ? t("imgHeroLine") : t("imgEmpty"),
      meta: current ? [
        current.sizeBytes ? el("span", { class: "chip" }, size(current.sizeBytes)) : null,
        current.publishedAt ? el("span", { class: "chip" }, `${t("libColPublished")}: `, ago(current.publishedAt)) : null,
        current.generalized === true ? badge("ok", t("gen_true")) : current.generalized === false ? badge("bad", t("gen_false")) : null,
      ].filter(Boolean) : null,
      rollback: imgs.rollback,
      rollbackLabel: t("imgRollbackBtn"),
      onRollback: async () => {
        if (await ask(t("imgRollbackConfirm", { label: imgs.rollback }), { ok: t("imgRollbackBtn") })) imageAct("/images/rollback", "POST");
      },
    }));

    $("img-warnings").hidden = imgs.warnings.length === 0;
    $("img-warning-list").replaceChildren(...warningItems(imgs.warnings));

    $("img-incoming-empty").hidden = imgs.incoming.length > 0 || !imgs.enabled;
    $("img-incoming").replaceChildren(...imgs.incoming.map((f) => {
      const suggested = f.name.replace(/\.(wim|esd)$/i, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 40);
      const label = el("input", { class: "input mono", value: suggested, title: t("labelHint") });
      const index = el("input", { class: "input", type: "number", min: "1", value: "1" });
      const error = el("span", { class: "field-error" });
      const submit = button(t("imgImport"), { type: "submit", cls: "lilac", ico: "download" });
      return el("form", { class: "incoming-item well", onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = "";
        submit.disabled = true;
        try {
          await api("/images/import", { method: "POST", body: JSON.stringify({ file: f.name, label: label.value.trim(), index: Number(index.value) }) });
          toast(t("imgImportStarted", { label: label.value.trim() }));
          imgsJson = "";
          await loadImages();
        } catch (err) {
          const key = `reason_${err.reason}`;
          error.textContent = err.reason === "format" ? t("labelHint") : has(key) ? t(key) : err.message;
        } finally {
          submit.disabled = false;
        }
      } },
        el("div", { class: "file" }, el("span", { class: "file-ico" }, icon("file", "sm")),
          el("div", {}, el("b", {}, f.name), el("span", { class: "small muted" }, size(f.sizeBytes), " · ", ago(f.modifiedAt)))),
        el("label", { class: "field label-f" }, el("span", {}, t("imgLabel")), label),
        el("label", { class: "field index-f" }, el("span", {}, t("imgIndex")), index),
        submit,
        error);
    }));

    renderBootFiles();

    $("img-empty").hidden = imgs.images.length > 0;
    $("img-rows").replaceChildren(...imgs.images.map((i) => {
      const badges = [badge(IMAGE_STATE[i.state] || "idle", t(`is_${i.state}`), i.lastError || "")];
      if (i.role) badges.push(badge(i.role === "current" ? "accent" : "info", t(i.role === "current" ? "imgCurrent" : "imgRollback"), null, "solid"));
      if (i.generalized === true) badges.push(badge("ok", t("gen_true"), null, "plain"));
      if (i.generalized === false) badges.push(badge("bad", t("gen_false"), null, "plain"));
      const editions = i.wimImages.map((w) => el("div", { class: w.index === i.imageIndex ? "picked" : "" },
        `${w.index}. ${w.name}`, w.build ? ` · ${w.build}` : "", w.architecture ? ` · ${w.architecture}` : ""));
      const actions = [];
      if (i.state === "ready" && i.role !== "current") {
        actions.push(button(t("imgPublish"), { cls: "sm", ico: "upload", onclick: async () => {
          if (await ask(t("imgPublishConfirm", { label: i.label }), { ok: t("imgPublish") })) imageAct(`/images/${encodeURIComponent(i.label)}/publish`, "POST");
        } }));
      }
      if (!i.publishedAt && !i.role && i.state !== "importing") {
        actions.push(iconButton("x", t("imgDelete"), async () => {
          if (await ask(t("imgDeleteConfirm", { label: i.label }), { danger: true, ok: t("imgDelete") })) imageAct(`/images/${encodeURIComponent(i.label)}`, "DELETE");
        }, "danger"));
      }
      return el("tr", {},
        el("td", { class: "mono" }, i.label),
        el("td", {}, el("div", { class: "cell-stack" }, el("div", { class: "badges" }, badges), i.lastError ? el("span", { class: "field-error" }, i.lastError) : null)),
        el("td", { class: "editions" }, editions.length ? editions : dash()),
        el("td", { class: "mono" }, size(i.sizeBytes)),
        el("td", { class: "mono muted", title: i.sha256 || "" }, i.sha256 ? `${i.sha256.slice(0, 12)}…` : dash()),
        el("td", {}, el("div", { class: "row-actions" }, actions)));
    }));
  }

  const BOOT_FILE = { ok: "ok", missing: "bad", invalid: "bad", unsigned: "warn", badSignature: "bad", wrongSigner: "warn" };

  function renderBootFiles() {
    const report = imgs.bootFiles;
    const files = report?.files ?? [];
    $("bf-no-tftp").hidden = !report || report.tftpChecked;
    const problems = files.filter((f) => f.status !== "ok" && f.required).length;
    $("bf-state").replaceChildren(files.length ? badge(problems ? "bad" : "ok", problems ? t("bfProblems", { n: problems }) : t("bfAllOk")) : "");
    $("bf-rows").replaceChildren(...files.map((f) => {
      const kind = f.status === "missing" && !f.required ? "idle" : BOOT_FILE[f.status] || "idle";
      const status = [badge(kind, t(`bf_${f.status}`), f.expected.length && f.status !== "ok" ? t("bfNotSecure") : "")];
      if (!f.required) status.push(el("span", { class: "small muted" }, t("bfOptional")));
      return el("tr", {},
        el("td", { class: "mono" }, f.name),
        el("td", {}, el("span", { class: "chip" }, f.location === "tftp" ? "TFTP" : "HTTP")),
        el("td", {}, el("div", { class: "badges" }, status)),
        el("td", {}, f.signedBy.length ? f.signedBy.join(", ") : f.expected.length ? dash() : ""),
        el("td", { class: "mono" }, orDash(f.component, true)),
        el("td", { class: "mono muted", title: f.sha256 || "" }, f.sha256 ? `${f.sha256.slice(0, 12)}…` : ""));
    }));
  }

  async function loadImages() {
    try {
      const fresh = await api("/images");
      const json = JSON.stringify(fresh);
      $("img-error").hidden = true;
      markOk();
      if (json !== imgsJson) {
        imgs = fresh;
        imgsJson = json;
        renderImages();
      }
    } catch (error) {
      if (error.message === "unauthorized") return;
      showError("img-error", error);
    }
  }

  async function imageAct(path, method) {
    try {
      await api(path, { method });
      toast(t("actionDone"));
    } catch (error) {
      toast(problemText(error), "bad");
    }
    imgsJson = "";
    await loadImages();
  }

  // ---------- Навигация ----------

  function renderHeader() {
    $("page-title").textContent = t({ machines: "navHall", library: "navGames", images: "navWindows", network: "navNetwork" }[view]);
    $("page-eyebrow").textContent = t(`sub_${view}`);
  }

  function route() {
    view = { "#network": "network", "#images": "images", "#library": "library" }[location.hash] ?? "machines";
    document.querySelectorAll(".rail-item").forEach((item) => {
      const on = item.dataset.view === view;
      item.classList.toggle("active", on);
      if (on) item.setAttribute("aria-current", "page"); else item.removeAttribute("aria-current");
    });
    renderHeader();
    if (!token) return;
    for (const name of VIEWS) $(name).hidden = view !== name;
    if (view === "images") imgsJson = "";
    if (view === "library") libJson = "";
    if (view === "network") {
      netJson = "";
      loadSettings(false);
    }
    window.scrollTo(0, 0);
    refresh();
  }

  function refresh() {
    load();
    if (view === "images") loadImages();
    if (view === "library") loadLibrary();
    loadNetwork();
  }

  async function load() {
    try {
      const fresh = await api("/machines");
      const json = JSON.stringify(fresh);
      $("load-error").hidden = true;
      markOk();
      if (json !== dataJson) {
        data = fresh;
        dataJson = json;
        render();
      } else {
        refreshAgo();
      }
    } catch (error) {
      if (error.message === "unauthorized") return;
      if (view === "machines") showError("load-error", error);
      else markFail();
    }
  }

  async function act(path, okText) {
    dataJson = "";
    try {
      await api(path, { method: "POST" });
      toast(okText || t("actionDone"));
    } catch (error) {
      toast(problemText(error), "bad");
    }
    await load();
  }

  function openEdit(machine) {
    editing = machine;
    $("edit-sub").textContent = [`${t("seat")} ${pad(machine.number)}`, machine.hostname, machine.ipAddress].filter(Boolean).join(" · ");
    $("edit-number").value = machine.number;
    $("edit-name").value = machine.name;
    $("edit-zone").replaceChildren(...data.zones.map((z) => el("option", { value: z.id }, z.name)));
    $("edit-zone").value = machine.zone;
    $("edit-maintenance").checked = machine.status === "maintenance";
    $("edit-error").hidden = true;
    $("edit").showModal();
  }

  async function saveEdit(event) {
    event.preventDefault();
    const body = {
      number: Number($("edit-number").value),
      name: $("edit-name").value.trim(),
      zone: $("edit-zone").value,
      maintenance: $("edit-maintenance").checked,
    };
    $("edit-save").disabled = true;
    try {
      await api(`/machines/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) });
      $("edit").close();
      toast(t("savedMachine", { name: body.name }));
      dataJson = "";
      await load();
    } catch (error) {
      $("edit-error").textContent = error.reason === "numberTaken" ? t("numberTaken") : error.message;
      $("edit-error").hidden = false;
    } finally {
      $("edit-save").disabled = false;
    }
  }

  function showApp() {
    $("login").hidden = true;
    $("app").hidden = false;
    route();
    clearInterval(timer);
    timer = setInterval(() => {
      if (document.hidden || anyDialogOpen()) { refreshAgo(); return; }
      refresh();
      refreshAgo();
    }, REFRESH_MS);
  }

  function logout() {
    token = null;
    safeSet(sessionStorage, "panel.token", null);
    clearInterval(timer);
    document.querySelectorAll("dialog[open]").forEach((d) => d.close());
    $("app").hidden = true;
    $("dhcp-alert").hidden = true;
    $("login").hidden = false;
    setTimeout(() => $("token").focus(), 0);
  }

  async function login(event) {
    event.preventDefault();
    token = $("token").value.trim();
    $("login-button").disabled = true;
    try {
      const response = await fetch(API + "/machines", { headers: { Authorization: `Bearer ${token}` } });
      if (response.ok) {
        safeSet(sessionStorage, "panel.token", token);
        $("login-error").hidden = true;
        $("token").value = "";
        showApp();
      } else {
        $("login-error").textContent = t("loginFailed");
        $("login-error").hidden = false;
      }
    } catch (error) {
      $("login-error").textContent = t("loadFailed", { error: error.message });
      $("login-error").hidden = false;
    } finally {
      $("login-button").disabled = false;
    }
  }

  function setLang(value) {
    lang = value;
    safeSet(localStorage, "panel.lang", lang);
    applyStaticTexts();
    dataJson = "";
    render();
    renderNetwork();
    renderCapacity();
    renderImages();
    renderLibrary();
    renderLive();
  }

  document.addEventListener("DOMContentLoaded", () => {
    applyStaticTexts();
    document.querySelectorAll("[data-lang]").forEach((select) => select.addEventListener("change", (e) => setLang(e.target.value)));
    $("lang").addEventListener("click", () => setLang(LANGS[(LANGS.indexOf(lang) + 1) % LANGS.length]));
    $("login-form").addEventListener("submit", login);
    $("logout").addEventListener("click", logout);
    $("refresh").addEventListener("click", () => {
      const btn = $("refresh");
      btn.classList.remove("spinning");
      void btn.offsetWidth;
      btn.classList.add("spinning");
      dataJson = ""; libJson = ""; imgsJson = ""; netJson = "";
      refresh();
    });
    $("edit-form").addEventListener("submit", saveEdit);
    $("net-form").addEventListener("submit", saveNetwork);
    $("net-form").addEventListener("input", () => { formDirty = true; $("net-saved").hidden = true; });
    $("net-download").addEventListener("click", downloadConfig);
    $("reimage-form").addEventListener("submit", startReimage);
    $("lib-publish").addEventListener("submit", publishLibrary);
    $("lib-label").addEventListener("input", () => { $("lib-label").dataset.auto = "0"; });
    document.querySelectorAll("dialog [data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
    $("confirm-no").addEventListener("click", () => $("confirm").close(""));
    $("confirm-yes").addEventListener("click", (e) => { e.preventDefault(); $("confirm").close("yes"); });
    $("m-search").addEventListener("input", (e) => { filters.text = e.target.value; renderFloor(); });
    $("m-admit").addEventListener("click", () => $("pending").scrollIntoView({ behavior: "smooth", block: "center" }));
    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && !anyDialogOpen() && view === "machines" && !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
        e.preventDefault();
        $("m-search").focus();
      }
    });
    window.addEventListener("hashchange", route);
    if (token) showApp(); else logout();
  });
})();
