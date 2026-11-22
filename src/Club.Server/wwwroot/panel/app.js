// Экраны «Рабочие станции», «Библиотека игр», «Образы Windows» и «Сеть».
// Без сборки и внешних зависимостей: панель работает в клубе без интернета.
(() => {
  "use strict";

  const API = "/panel/api/v1";
  const REFRESH_MS = 5000;
  const VIEWS = ["machines", "library", "images", "network"];
  const $ = (id) => document.getElementById(id);

  let lang = safeGet(localStorage, "panel.lang") || "ru";
  let theme = safeGet(localStorage, "panel.theme") || "auto";
  let token = safeGet(sessionStorage, "panel.token");
  let data = null;
  let dataJson = "";
  let timer = null;
  let editing = null;
  let view = "machines";
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
  const filters = {
    text: "",
    status: safeGet(localStorage, "panel.filter") || "all",
    zone: "",
    mode: safeGet(localStorage, "panel.mode") || "grid",
  };
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

  function applyStaticTexts() {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach((node) => { node.textContent = t(node.dataset.i18n); });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => { node.placeholder = t(node.dataset.i18nPlaceholder); });
    document.querySelectorAll("[data-i18n-title]").forEach((node) => {
      node.title = t(node.dataset.i18nTitle);
      node.setAttribute("aria-label", node.title);
    });
    document.querySelectorAll("[data-lang]").forEach((select) => { select.value = lang; });
    document.title = t("brand");
    renderHeader();
    renderFilters();
    applyTheme();
  }

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") node.className = v;
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
    return el("button", { type: "button", class: `icon-btn sm ${cls}`.trim(), title, "aria-label": title, onclick }, icon(ico));
  }

  // Прочерк вместо отсутствующего или невменяемого значения (сервер уже отбросил невозможные).
  const dash = () => el("span", { class: "dash" }, "—");
  const orDash = (value, mono) => (value === null || value === undefined || value === "" ? dash() : el("span", { class: mono ? "mono" : "" }, value));

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
    return response.status === 204 || response.status === 202 && response.headers.get("content-length") === "0" ? null : response.json().catch(() => null);
  }

  // Отметка «данные свежие» для индикатора в шапке.
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

  function renderLive() {
    const live = $("live");
    if (!lastOk) { $("live-text").textContent = "…"; return; }
    live.classList.toggle("stale", lastFail);
    $("live-text").textContent = lastFail ? t("liveStale") : t("liveUpdated", { ago: agoText(new Date(lastOk).toISOString()) });
  }

  // ---------- Уведомления и подтверждения ----------

  function toast(text, kind = "ok") {
    const ico = { ok: "check", bad: "alert", info: "info" }[kind] || "info";
    const node = el("div", { class: `toast ${kind}`, role: kind === "bad" ? "alert" : "status" }, icon(ico), el("span", {}, text),
      el("button", { type: "button", class: "icon-btn sm", "aria-label": t("close"), onclick: () => dismiss() }, icon("x")));
    const dismiss = () => {
      node.classList.add("out");
      setTimeout(() => node.remove(), 200);
    };
    $("toasts").append(node);
    setTimeout(dismiss, kind === "bad" ? 9000 : 4000);
  }

  // Своё окно вместо confirm(): тот же текст, но в стиле панели и с понятной главной кнопкой.
  function ask(text, opts = {}) {
    const { title = t("confirmTitle"), ok = t("confirmOk"), danger = false } = opts;
    const dialog = $("confirm");
    $("confirm-title").textContent = title;
    $("confirm-text").textContent = text;
    $("confirm-yes").textContent = ok;
    $("confirm-yes").className = `btn ${danger ? "danger" : "primary"}`;
    $("confirm-ico").className = `ico-wrap lg ${danger ? "bad" : "accent"}`;
    $("confirm-ico").replaceChildren(icon(danger ? "alert" : "info"));
    return new Promise((resolve) => {
      const done = (value) => {
        dialog.removeEventListener("close", onClose);
        resolve(value);
      };
      const onClose = () => done(dialog.returnValue === "yes");
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

  const REIMAGE = {
    requested: "info",
    deploying: "info",
    failed: "bad",
    booting: "info",
    done: "ok",
    cancelled: "idle",
  };

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

  // Версия образа на ПК и ход перезаливки: этап, проценты, причина сбоя.
  function windowsParts(m) {
    const r = m.reimage;
    const parts = [m.imageVersion ? el("span", { class: "mono" }, m.imageVersion) : dash()];
    if (m.masterState) {
      parts.push(el("div", {}, badge(m.masterState === "failed" ? "bad" : "warn", t("masterBadge", { letter: "M" }), t(`mm_${m.masterState}`))));
    }
    const sb = m.secureBoot;
    if (sb && sb.enabled !== null && sb.enabled !== undefined) {
      const title = `db: CA 2011 ${sb.thirdPartyCa2011 ? "✓" : "✗"}, CA 2023 ${sb.windowsCa2023 ? "✓" : "✗"}; dbx: PCA 2011 ${sb.pca2011Revoked ? "✗" : "—"}`;
      const sbBadges = [badge(sb.enabled ? "ok" : "idle", t(sb.enabled ? "sbOn" : "sbOff"), title)];
      if (sb.enabled && sb.thirdPartyCa2011 === false) sbBadges.push(badge("bad", t("sbNoCa2011"), title));
      if (sb.enabled && sb.pca2011Revoked) sbBadges.push(badge("info", t("sbRevoked"), title));
      parts.push(el("div", { class: "badges" }, sbBadges));
    }
    if (r) {
      let text = t(`rs_${r.state}`);
      if (r.state === "deploying" && r.step) text += ` · ${t(`st_${r.step}`)}${r.percent !== null && r.percent !== undefined ? ` ${r.percent}%` : ""}`;
      if (r.state === "failed" && r.failure) {
        const key = `fr_${r.failure}`;
        text += ` · ${t(key) === key ? t(`st_${r.failure}`) : t(key)}`;
      }
      if (r.attempts > 1) text += ` (#${r.attempts})`;
      parts.push(el("div", {}, badge(REIMAGE[r.state] || "idle", text, r.message || "")));
      if (r.state === "deploying" && r.step === "download" && r.percent !== null && r.percent !== undefined) {
        parts.push(el("div", { class: "progress" }, el("span", { style: `width:${r.percent}%` })));
      }
    }
    return el("div", { class: "cell-stack" }, parts);
  }

  function machineActions(m) {
    const r = m.reimage;
    const active = r && ["requested", "deploying", "failed", "booting"].includes(r.state);
    const buttons = [iconButton("edit", t("edit"), () => openEdit(m))];
    if (!active || r.state === "booting" || r.state === "failed") {
      buttons.push(iconButton("reimage", t("reimage"), () => openReimage(m)));
    }
    if (r && ["requested", "failed"].includes(r.state) && !r.diskTouched) {
      buttons.push(iconButton("x", t("reimageCancel"), async () => {
        if (await ask(t("reimageConfirmCancel", { name: m.name }), { danger: true, ok: t("reimageCancel") })) act(`/machines/${m.id}/reimage/cancel`);
      }, "danger"));
    }
    return el("div", { class: "row-actions" }, buttons);
  }

  function zoneName(id) {
    return data?.zones.find((z) => z.id === id)?.name ?? id;
  }

  // Требует внимания: нет связи, ошибка тома, том не проверен на запись, сбой перезаливки.
  function needsAttention(m) {
    const v = m.volume || {};
    return m.status === "offline" || v.state === "failed" || v.outdated
      || (v.state === "mounted" && v.readOnlyVerified !== true) || m.reimage?.state === "failed"
      || (m.secureBoot?.enabled && m.secureBoot?.thirdPartyCa2011 === false);
  }

  const FILTERS = {
    all: () => true,
    online: (m) => m.status === "online",
    offline: (m) => m.status === "offline" || m.status === "neverSeen",
    attention: needsAttention,
    service: (m) => m.status === "maintenance" || m.status === "reimaging",
  };

  // ---------- Рабочие станции ----------

  function kpi(kind, ico, label, value, sub, opts = {}) {
    return el("div", { class: `kpi ${kind}${opts.onclick ? " clickable" : ""}`, onclick: opts.onclick },
      el("div", { class: "kpi-top" }, el("span", {}, label), el("span", { class: `ico-wrap ${kind}` }, icon(ico))),
      el("div", { class: `kpi-value${opts.text ? " text" : ""}`, title: opts.text ? value || "" : null }, value ?? "—"),
      sub ? el("div", { class: "kpi-sub" }, sub) : null);
  }

  function setFilter(status) {
    filters.status = status;
    safeSet(localStorage, "panel.filter", status);
    renderFilters();
    renderRows();
  }

  function renderSummary() {
    const total = data.machines.filter((m) => m.status !== "pendingApproval").length;
    const service = (data.maintenance || 0) + (data.reimaging || 0);
    $("summary").replaceChildren(
      kpi("ok", "monitor", t("kpiOnline"), data.online, t("kpiOf", { n: total }), { onclick: () => setFilter("online") }),
      kpi("bad", "wifi-off", t("kpiOffline"), data.offline, null, { onclick: () => setFilter("offline") }),
      data.pending ? kpi("warn", "user-plus", t("kpiPending"), data.pending, null) : kpi("info", "wrench", t("kpiService"), service, data.reimaging ? `${data.reimaging} ${t("sumReimaging")}` : null, { onclick: () => setFilter("service") }),
      kpi("accent", "layers", t("kpiLibrary"), data.currentLibraryVersion, null, { text: true, onclick: () => { location.hash = "#library"; } }),
      kpi("accent", "windows", t("kpiImage"), data.currentImageVersion, null, { text: true, onclick: () => { location.hash = "#images"; } }));
  }

  function renderPending() {
    const pending = data.machines.filter((m) => m.status === "pendingApproval");
    $("pending").hidden = pending.length === 0;
    $("pending-count").textContent = pending.length;
    $("pending-list").replaceChildren(...pending.map((m) => el("div", { class: "pending-item" },
      el("div", { class: "ph" }, el("span", { class: "seat-mini" }, m.number), el("b", {}, m.hostname)),
      el("div", { class: "meta" },
        m.macAddresses.length ? el("span", { class: "mono" }, m.macAddresses.join(", ")) : null,
        el("span", {}, m.ipAddress ? `IP ${m.ipAddress} · ` : "", t("registered"), " ", ago(m.registeredAt))),
      el("div", { class: "actions" },
        button(t("approve"), { cls: "primary sm", ico: "check", onclick: () => act(`/machines/${m.id}/approve`, t("approved", { name: m.hostname })) }),
        button(t("reject"), { cls: "danger-ghost sm", ico: "x", onclick: async () => {
          if (await ask(t("rejectConfirm", { name: m.hostname }), { danger: true, ok: t("reject") })) act(`/machines/${m.id}/reject`);
        } })))));
  }

  function renderFilters() {
    const list = data ? data.machines.filter((m) => m.status !== "pendingApproval") : [];
    $("m-filter").replaceChildren(...Object.keys(FILTERS).map((key) => el("button", {
      type: "button", class: filters.status === key ? "active" : "", onclick: () => setFilter(key),
    }, t(`flt_${key}`), data ? el("b", {}, list.filter(FILTERS[key]).length) : null)));
    $("m-view").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.mode === filters.mode));
    const zones = data?.zones ?? [];
    $("m-zone").hidden = zones.length < 2;
    $("m-zone").replaceChildren(el("option", { value: "" }, t("allZones")), ...zones.map((z) => el("option", { value: z.id }, z.name)));
    $("m-zone").value = filters.zone;
  }

  function filteredMachines() {
    const q = filters.text.trim().toLowerCase();
    return data.machines
      .filter((m) => m.status !== "pendingApproval")
      .filter(FILTERS[filters.status] || FILTERS.all)
      .filter((m) => !filters.zone || m.zone === filters.zone)
      .filter((m) => !q || [String(m.number), m.name, m.hostname, m.ipAddress, ...(m.macAddresses || []), m.helperVersion]
        .some((v) => v && String(v).toLowerCase().includes(q)));
  }

  function seatCard(m) {
    const [kind, key] = STATUS[m.status] || ["idle", m.status];
    const prop = (label, value) => el("div", { class: "seat-prop" }, el("span", {}, label), el("div", {}, value));
    return el("article", { class: `seat ${kind}` },
      el("div", { class: "seat-head" },
        el("div", { class: "seat-no" }, m.number),
        el("div", { class: "seat-name" },
          el("b", { title: m.name }, m.name),
          m.hostname && m.hostname !== m.name ? el("span", { class: "muted mono" }, m.hostname) : null,
          badge(kind, t(key), null, m.status === "online" ? "pulse" : "")),
        zoneTag(m.zone)),
      el("div", { class: "seat-props" },
        prop(t("colVolume"), volumeBadges(m.volume)),
        prop(t("colImage"), windowsParts(m)),
        prop(t("colIp"), orDash(m.ipAddress, true)),
        m.helperVersion ? prop(t("colHelper"), el("span", { class: "mono" }, m.helperVersion)) : null),
      el("div", { class: "seat-foot" },
        el("span", { class: "seen" }, icon("clock"), ago(m.lastSeenAt)),
        machineActions(m)));
  }

  function zoneTag(zone) {
    return zone && (data?.zones.length ?? 0) > 1 ? el("span", { class: "zone-tag" }, zoneName(zone)) : null;
  }

  function renderRows() {
    if (!data) return;
    const all = data.machines.filter((m) => m.status !== "pendingApproval");
    const machines = filteredMachines();
    $("empty").hidden = all.length > 0;
    $("m-nomatch").hidden = all.length === 0 || machines.length > 0;
    const grid = filters.mode === "grid";
    $("m-grid").hidden = !grid || machines.length === 0;
    $("m-table").hidden = grid || machines.length === 0;
    if (grid) {
      $("m-grid").replaceChildren(...machines.map(seatCard));
      return;
    }
    $("rows").replaceChildren(...machines.map((m) => {
      const [kind, key] = STATUS[m.status] || ["idle", m.status];
      return el("tr", {},
        el("td", {}, el("span", { class: "seat-mini" }, m.number)),
        el("td", {}, el("div", { class: "cell-stack" }, el("b", {}, m.name), m.hostname && m.hostname !== m.name ? el("span", { class: "cell-sub mono" }, m.hostname) : null)),
        el("td", {}, badge(kind, t(key), null, m.status === "online" ? "pulse" : "")),
        el("td", { class: "mono" }, orDash(m.ipAddress, true)),
        el("td", { class: "mono" }, m.macAddresses.length ? m.macAddresses.join(", ") : dash()),
        el("td", {}, zoneName(m.zone)),
        el("td", {}, volumeBadges(m.volume)),
        el("td", { class: "reimage-cell" }, windowsParts(m)),
        el("td", {}, orDash(m.helperVersion, true)),
        el("td", { class: "muted" }, ago(m.lastSeenAt)),
        el("td", {}, machineActions(m)));
    }));
  }

  function renderNavCounters() {
    const setCount = (id, n, kind) => {
      const node = $(id);
      node.hidden = !n;
      node.textContent = n || "";
      node.className = `nav-count${kind ? ` ${kind}` : ""}`;
    };
    if (data) {
      const total = data.machines.filter((m) => m.status !== "pendingApproval").length;
      setCount("nav-machines", data.pending, "");
      $("side-online-n").textContent = data.online;
      $("side-online-of").textContent = total ? ` / ${total}` : "";
      $("side-online-bar").style.width = total ? `${(100 * data.online) / total}%` : "0";
    }
    if (lib) setCount("nav-library", lib.warnings.length || lib.openOperations.length, lib.warnings.length ? "" : "info");
    if (imgs) setCount("nav-images", imgs.warnings.length, "");
    if (net) setCount("nav-network", net.foreignDhcp.length || net.warnings.length, net.foreignDhcp.length ? "bad" : "");
  }

  function render() {
    if (!data) return;
    renderNavCounters();
    renderSummary();
    renderPending();
    renderFilters();
    renderRows();
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
    const chip = (kind, text, title) => chips.push(badge(kind, text, title));
    if (!net.keaEnabled) chip("idle", t("keaOff"));
    else if (!net.sync) chip("idle", t("keaNever"));
    else if (net.sync.error) chip("bad", t("keaUnavailable"), net.sync.error);
    else if (!net.sync.schemaOk) chip("bad", t("keaSchemaBad", { v: net.sync.schemaVersion ?? "—" }));
    else chip("ok", t("keaSchema", { v: net.sync.schemaVersion }));
    if (net.sync?.at) chips.push(el("span", { class: "chip" }, icon("refresh"), `${t("keaSynced")}: `, ago(net.sync.at)));
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
      el("td", {}, el("span", { class: "seat-mini" }, r.seat)),
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
    form.querySelectorAll("input.invalid").forEach((node) => node.classList.remove("invalid"));
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
        form.querySelector("input.invalid")?.focus();
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
    return error.reason && t(key) !== key ? t(key) : error.message;
  }

  async function openReimage(machine) {
    reimaging = machine;
    $("reimage-name").textContent = `№ ${machine.number} · ${machine.name}`;
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

  // ---------- Библиотека игр ----------

  const LIB_STATE = { publishing: "info", published: "ok", retiring: "idle", retired: "idle", failed: "bad" };
  const OP_STATUS = { pending: "idle", running: "info", done: "ok", failed: "bad" };
  const PUBLISH_STEPS = ["snapshot", "clone", "extent", "target", "promote"];
  const MASTER_OPEN_STEPS = ["auth", "initiator", "extent", "target"];
  const MASTER_CLOSE_STEPS = ["target", "extent", "initiator", "auth"];

  function suggestLabel() {
    const d = new Date();
    const base = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const taken = new Set((lib?.versions ?? []).map((v) => v.label));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }

  // Карточка «текущая / откатная версия» — общая для библиотеки и образов.
  function versionHero(opts) {
    const { title, ico, current, currentMeta, rollback, onRollback, rollbackLabel } = opts;
    return [
      el("div", { class: "hero-label" }, icon(ico), title),
      el("div", { class: `hero-value${current ? "" : " none"}` }, current || t("noVersion")),
      currentMeta ? el("div", { class: "hero-meta" }, currentMeta) : null,
      el("div", { class: "hero-rollback" },
        el("span", { class: "ico-wrap" }, icon("undo")),
        el("div", {}, el("div", { class: "small" }, t("rollbackVersion")), rollback ? el("b", {}, rollback) : dash()),
        rollback ? button(rollbackLabel, { cls: "sm", ico: "undo", onclick: onRollback }) : null),
    ];
  }

  function renderAdoption() {
    const a = lib.machines;
    if (!a || a.online === 0) {
      $("lib-adoption").replaceChildren(el("div", { class: "empty-state compact" }, el("p", { class: "muted" }, t("libNoOnline"))));
      return;
    }
    const colors = { onCurrent: "var(--ok)", onOlder: "var(--info)", switchPending: "var(--warn)", failed: "var(--bad)", notMounted: "var(--border-strong)" };
    const parts = Object.keys(colors).filter((key) => a[key] > 0);
    let acc = 0;
    const stops = parts.map((key) => {
      const from = acc;
      acc += (100 * a[key]) / a.online;
      return `${colors[key]} ${from}% ${acc}%`;
    });
    if (acc < 100) stops.push(`var(--surface-3) ${acc}% 100%`);
    const pct = Math.round((100 * (a.onCurrent || 0)) / a.online);
    $("lib-adoption").replaceChildren(el("div", { class: "adoption" },
      el("div", { class: "donut", style: `background: conic-gradient(${stops.join(", ")})`, title: t("libOnlineOf", { n: a.online }) },
        el("div", { class: "donut-center" }, el("b", {}, `${pct}%`), el("span", {}, t("ad_onCurrent")))),
      el("div", { class: "legend" },
        el("div", { class: "legend-head" }, t("libOnlineOf", { n: a.online })),
        parts.map((key) => el("div", {}, el("i", { style: `background:${colors[key]}` }), el("span", {}, t(`ad_${key}`)), el("b", {}, a[key]))))));
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
    return el("div", { class: "op" },
      el("div", { class: "op-head" },
        el("div", {}, el("b", {}, t(`op_${op.kind}`)), op.versionLabel ? el("span", { class: "mono" }, op.versionLabel) : null,
          badge(OP_STATUS[op.status] || "idle", t(`os_${op.status}`)), op.attempts > 1 ? el("span", { class: "muted small" }, `#${op.attempts}`) : null,
          el("span", { class: "muted small" }, ago(op.updatedAt || op.createdAt))),
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
    $("lib-master-card").classList.toggle("open", isOpen);
    $("lib-master-ico").className = `ico-wrap ${isOpen ? "warn" : ""}`;
    $("lib-master-ico").replaceChildren(icon(isOpen ? "unlock" : "lock"));
    if (!m) { box.replaceChildren(); return; }
    const parts = [];

    if (m.state !== "closed") {
      const head = [];
      if (m.driveLetter) head.push(el("span", { class: "drive" }, `${m.driveLetter}:`));
      head.push(el("div", { class: "who" },
        m.machineName ? el("b", {}, t("masterOnPc", { name: m.machineName, letter: m.driveLetter })) : null,
        m.openedAt && m.state === "open" ? el("span", { class: "muted small" }, `${t("masterSince")} `, ago(m.openedAt)) : null));
      head.push(el("div", { class: "badges" },
        badge(MASTER_STATE[m.state] || "idle", t(`ms_${m.state}`)),
        m.state === "open" ? badge(MASTER_MACHINE[m.machineState ?? "none"] || "idle", t(`mm_${m.machineState ?? "none"}`)) : null));
      parts.push(el("div", { class: "master-status" }, head));
    }
    if (m.state === "closing") parts.push(el("p", { class: "hint-box" }, t("masterWaiting")));
    if (m.lastError && m.state !== "open") parts.push(el("p", { class: "form-error" }, m.lastError));
    if (m.dirty && m.state === "closed") parts.push(el("p", { class: "banner warn" }, icon("alert"), el("span", {}, t("masterDirty"))));

    const actions = [];
    if (m.state === "closed") {
      const candidates = lib.masterCandidates ?? [];
      if (candidates.length === 0) {
        parts.push(el("p", { class: "hint-box" }, t("masterNoCandidates")));
      } else {
        const select = el("select", { class: "select", "aria-label": t("masterPc") }, candidates.map((c) =>
          el("option", { value: c.id }, `№ ${c.number} · ${c.name}${c.online ? ` · ${t("online")}` : ""}`)));
        actions.push(select, button(t("masterOpen"), { cls: "primary", ico: "unlock", onclick: () => libAct("/library/master/open", { machineId: select.value }) }));
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
    box.replaceChildren(el("div", { class: "master-body" }, parts));

    const blocked = m.state !== "closed";
    $("lib-publish-button").disabled = blocked;
    $("lib-publish-button").title = blocked ? t("masterBlocksPublish") : "";
  }

  function contentsCell(v) {
    if (!v.contents) return el("td", { class: "muted small", title: t("libContentsHint") }, v.state === "published" ? t("libNoContents") : "");
    const details = el("details", { title: t("libContentsHint") },
      el("summary", {}, icon("chevron"), t("libFolders", { n: v.contents.length })),
      el("div", { class: "folders" }, v.contents.map((name) => el("span", { class: "folder" }, icon("folder"), name))));
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
      ico: "layers",
      current: lib.current?.label,
      currentMeta: lib.current ? [
        lib.current.publishedAt ? el("span", {}, `${t("libColPublished")}: `, ago(lib.current.publishedAt)) : null,
        lib.current.mountedOn ? el("span", {}, t("onPcs", { n: lib.current.mountedOn })) : null,
      ] : null,
      rollback: lib.rollback?.label,
      rollbackLabel: t("libRollback"),
      onRollback: async () => {
        if (await ask(t("libRollbackConfirm", { label: lib.rollback.label }), { ok: t("libRollback") })) libAct("/library/rollback", undefined, t("actionQueued"));
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
      if (v.role) badges.push(badge(v.role === "current" ? "accent" : "info", t(v.role === "current" ? "imgCurrent" : "imgRollback"), null, "plain"));
      return el("tr", { class: v.state === "retired" ? "retired" : "" },
        el("td", { class: "mono" }, el("b", {}, v.label)),
        el("td", {}, el("div", { class: "cell-stack" }, el("div", { class: "badges" }, badges), v.lastError ? el("span", { class: "field-error" }, v.lastError) : null)),
        el("td", { class: "num" }, v.mountedOn ? el("span", { class: "seat-mini" }, v.mountedOn) : dash()),
        contentsCell(v),
        el("td", { class: "muted" }, v.publishedAt ? ago(v.publishedAt) : dash()),
        el("td", { class: "mono small muted" }, orDash(v.targetIqn, true)));
    }));

    if (libHistory) {
      $("lib-history").replaceChildren(...libHistory.map((op) => el("tr", {},
        el("td", { class: "muted" }, ago(op.createdAt)),
        el("td", {}, el("b", {}, t(`op_${op.kind}`))),
        el("td", { class: "mono" }, orDash(op.versionLabel, true)),
        el("td", {}, el("div", { class: "badges" }, badge(OP_STATUS[op.status] || "idle", t(`os_${op.status}`), op.lastError || ""),
          op.step && op.status !== "done" ? el("span", { class: "muted small" }, t(`step_${op.step}`)) : null)),
        el("td", { class: "num" }, op.attempts),
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
      $("lib-publish-error").textContent = error.reason === "format" ? t("libLabelHint") : t(key) !== key ? t(key) : error.message;
      $("lib-publish-error").hidden = false;
    } finally {
      $("lib-publish-button").disabled = lib?.master ? lib.master.state !== "closed" : false;
    }
  }

  // ---------- Образы Windows ----------

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
      ico: "windows",
      current: imgs.current,
      currentMeta: current ? [
        current.sizeBytes ? el("span", {}, size(current.sizeBytes)) : null,
        current.publishedAt ? el("span", {}, `${t("libColPublished")}: `, ago(current.publishedAt)) : null,
        current.generalized === true ? badge("ok", t("gen_true")) : current.generalized === false ? badge("bad", t("gen_false")) : null,
      ] : null,
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
      const label = el("input", { class: "mono", value: suggested, title: t("labelHint") });
      const index = el("input", { type: "number", min: "1", value: "1" });
      const error = el("span", { class: "field-error" });
      const submit = button(t("imgImport"), { type: "submit", cls: "primary", ico: "download" });
      return el("form", { class: "incoming-item", onsubmit: async (e) => {
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
          error.textContent = err.reason === "format" ? t("labelHint") : t(key) !== key ? t(key) : err.message;
        } finally {
          submit.disabled = false;
        }
      } },
        el("div", { class: "file" }, el("span", { class: "ico-wrap accent" }, icon("file")),
          el("div", {}, el("b", {}, f.name), el("span", { class: "muted small" }, size(f.sizeBytes), " · ", ago(f.modifiedAt)))),
        el("label", { class: "field stacked label-f" }, el("span", {}, t("imgLabel")), label),
        el("label", { class: "field stacked index-f" }, el("span", {}, t("imgIndex")), index),
        submit,
        error);
    }));

    renderBootFiles();

    $("img-empty").hidden = imgs.images.length > 0;
    $("img-rows").replaceChildren(...imgs.images.map((i) => {
      const badges = [badge(IMAGE_STATE[i.state] || "idle", t(`is_${i.state}`), i.lastError || "")];
      if (i.role) badges.push(badge(i.role === "current" ? "accent" : "info", t(i.role === "current" ? "imgCurrent" : "imgRollback"), null, "plain"));
      if (i.generalized === true) badges.push(badge("ok", t("gen_true"), null, "plain"));
      if (i.generalized === false) badges.push(badge("bad", t("gen_false"), null, "plain"));
      const editions = i.wimImages.map((w) => el("div", { class: w.index === i.imageIndex ? "picked" : "" },
        `${w.index}. ${w.name}`, w.build ? ` · ${w.build}` : "", w.architecture ? ` · ${w.architecture}` : ""));
      const actions = [];
      if (i.state === "ready" && i.role !== "current") {
        actions.push(button(t("imgPublish"), { cls: "soft sm", ico: "upload", onclick: async () => {
          if (await ask(t("imgPublishConfirm", { label: i.label }), { ok: t("imgPublish") })) imageAct(`/images/${encodeURIComponent(i.label)}/publish`, "POST");
        } }));
      }
      if (!i.publishedAt && !i.role && i.state !== "importing") {
        actions.push(iconButton("x", t("imgDelete"), async () => {
          if (await ask(t("imgDeleteConfirm", { label: i.label }), { danger: true, ok: t("imgDelete") })) imageAct(`/images/${encodeURIComponent(i.label)}`, "DELETE");
        }, "danger"));
      }
      return el("tr", {},
        el("td", { class: "mono" }, el("b", {}, i.label)),
        el("td", {}, el("div", { class: "cell-stack" }, el("div", { class: "badges" }, badges), i.lastError ? el("span", { class: "field-error" }, i.lastError) : null)),
        el("td", { class: "editions" }, editions.length ? editions : dash()),
        el("td", { class: "num" }, size(i.sizeBytes)),
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
      if (!f.required) status.push(el("span", { class: "muted small" }, t("bfOptional")));
      return el("tr", {},
        el("td", { class: "mono" }, el("b", {}, f.name)),
        el("td", {}, el("span", { class: "zone-tag" }, f.location === "tftp" ? "TFTP" : "HTTP")),
        el("td", {}, el("div", { class: "badges" }, status)),
        el("td", { class: "small" }, f.signedBy.length ? f.signedBy.join(", ") : f.expected.length ? dash() : ""),
        el("td", { class: "mono small" }, orDash(f.component, true)),
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

  // ---------- Тема ----------

  function applyTheme() {
    if (theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    const btn = $("theme");
    btn.replaceChildren(icon({ auto: "auto", light: "sun", dark: "moon" }[theme] || "auto"));
    btn.title = `${t("themeToggle")}: ${t(`theme_${theme}`)}`;
    btn.setAttribute("aria-label", btn.title);
  }

  function cycleTheme() {
    theme = { auto: "light", light: "dark", dark: "auto" }[theme] || "auto";
    safeSet(localStorage, "panel.theme", theme === "auto" ? null : theme);
    applyTheme();
  }

  // ---------- Навигация ----------

  function renderHeader() {
    $("page-title").textContent = t({ machines: "tabMachines", library: "tabLibrary", images: "tabImages", network: "tabNetwork" }[view]);
    $("page-sub").textContent = t(`sub_${view}`);
  }

  function closeNav() {
    $("app").classList.remove("nav-open");
    $("scrim").hidden = true;
  }

  function route() {
    view = { "#network": "network", "#images": "images", "#library": "library" }[location.hash] ?? "machines";
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
    renderHeader();
    closeNav();
    if (!token) return;
    for (const name of VIEWS) $(name).hidden = view !== name;
    if (view === "images") { imgsJson = ""; }
    if (view === "library") { libJson = ""; }
    if (view === "network") {
      netJson = "";
      loadSettings(false);
    }
    $("app").querySelector(".main").scrollTo?.(0, 0);
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
    $("edit-sub").textContent = [machine.hostname, machine.ipAddress].filter(Boolean).join(" · ");
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
    $("theme").addEventListener("click", cycleTheme);
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
    $("menu").addEventListener("click", () => { $("app").classList.add("nav-open"); $("scrim").hidden = false; });
    $("scrim").addEventListener("click", closeNav);
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

    $("m-search").addEventListener("input", (e) => { filters.text = e.target.value; renderRows(); });
    $("m-zone").addEventListener("change", (e) => { filters.zone = e.target.value; renderRows(); });
    $("m-view").addEventListener("click", (e) => {
      const mode = e.target.closest("button")?.dataset.mode;
      if (!mode) return;
      filters.mode = mode;
      safeSet(localStorage, "panel.mode", mode);
      renderFilters();
      renderRows();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && !anyDialogOpen() && view === "machines" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        $("m-search").focus();
      }
    });

    window.addEventListener("hashchange", route);
    if (token) showApp(); else logout();
  });
})();
