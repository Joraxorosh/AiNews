(() => {
  "use strict";

  const PAGE = 50;
  const VALID_PERIODS = new Set([0, 1, 3, 7, 30]);
  const CATS = { models: "Модели ИИ", tools: "Инструменты", science: "Наука", it: "IT и безопасность" };
  const $ = (id) => document.getElementById(id);

  // ---- localStorage — только для личных удобств, всё обёрнуто в try/catch ----
  const store = {
    get(k, def) { try { const v = localStorage.getItem(k); return v === null ? def : JSON.parse(v); } catch { return def; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим и т.п. */ } },
  };

  // ---- Тема ----
  const applyTheme = (t) => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
  applyTheme(store.get("theme", null));
  $("theme-toggle").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    applyTheme(next); store.set("theme", next);
  });

  // ---- Утилиты ----
  const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");
  const rtf = new Intl.RelativeTimeFormat("ru", { numeric: "auto" });
  const dtShort = new Intl.DateTimeFormat("ru", { day: "numeric", month: "short", year: "numeric" });
  const dtFull = new Intl.DateTimeFormat("ru", { dateStyle: "short", timeStyle: "short" });
  const dtDay = new Intl.DateTimeFormat("ru");
  const parseMs = (iso) => {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : 0;
  };
  function ago(ms) {
    if (!ms) return "";
    const diff = (ms - Date.now()) / 1000;
    if (Math.abs(diff) < 60) return "только что";
    if (Math.abs(diff) < 3600) return rtf.format(Math.round(diff / 60), "minute");
    if (Math.abs(diff) < 86400) return rtf.format(Math.round(diff / 3600), "hour");
    if (Math.abs(diff) < 86400 * 7) return rtf.format(Math.round(diff / 86400), "day");
    return dtShort.format(ms);
  }
  const formatFullDate = (ms) => (ms ? dtFull.format(ms) : "");
  const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  };

  function hydrateItem(raw) {
    const tags = Array.isArray(raw.tags) ? raw.tags : [];
    const title = String(raw.title || "");
    const summary = String(raw.summary || "");
    return {
      ...raw,
      title,
      summary,
      tags,
      _pubMs: parseMs(raw.published),
      _seenMs: parseMs(raw.first_seen),
      _search: (title + " " + summary).toLowerCase(),
    };
  }

  function stripInternal(it) {
    const { _pubMs, _seenMs, _search, ...clean } = it;
    return clean;
  }

  function loadSaved() {
    const raw = store.get("savedItems", {});
    const map = new Map();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return map;
    for (const [id, it] of Object.entries(raw)) {
      if (it && typeof it === "object" && it.id && it.title) map.set(id, hydrateItem(it));
    }
    return map;
  }

  function persistSaved() {
    const out = {};
    for (const [id, it] of state.saved) out[id] = stripInternal(it);
    store.set("savedItems", out);
  }

  // ---- Состояние ----
  const state = {
    tab: "feed", items: [], byId: new Map(), sources: {}, kb: null, newsError: false,
    q: "", period: 7, source: "", onlyNew: false, tag: "", shown: PAGE,
    kbQ: "", kbSection: "", digestDays: 1,
    lastGroups: [],
    // Избранное хранит копии записей: так они не пропадут, когда выпадут из ленты (хранится 45 дней).
    saved: loadSaved(),
  };
  // «Новое» = появилось после предыдущего визита. Время визита обновляем один раз за загрузку.
  const prevVisitMs = parseMs(store.get("lastVisit", null));
  store.set("lastVisit", new Date().toISOString());
  const isNew = (it) => prevVisitMs > 0 && it._seenMs > prevVisitMs;

  if (!prevVisitMs) {
    const cb = $("only-new");
    cb.disabled = true;
    cb.parentElement.title = "Доступно со второго визита";
  }

  // ---- Вкладки ----
  let searchTimer = 0;
  let kbSearchTimer = 0;
  function setTab(tab, isInitial = false) {
    if (!["feed", "digest", "saved", "kb", ...Object.keys(CATS)].includes(tab)) tab = "feed";
    const changed = state.tab !== tab;
    clearTimeout(searchTimer);
    clearTimeout(kbSearchTimer);
    state.tab = tab; state.shown = PAGE; state.tag = "";
    document.querySelectorAll("#tabs a").forEach((a) => {
      const active = a.dataset.tab === tab;
      a.classList.toggle("active", active);
      if (active) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    $("news-view").hidden = tab === "kb" || tab === "digest";
    $("kb-view").hidden = tab !== "kb";
    $("digest-view").hidden = tab !== "digest";
    if (changed && !isInitial) window.scrollTo(0, 0);
    if (tab === "kb") renderKb(); else if (tab === "digest") renderDigest(); else { fillSources(); renderNews(); }
  }
  window.addEventListener("hashchange", () => setTab(location.hash.slice(1)));

  // ---- Новости ----
  const byNewest = (a, b) => (b._pubMs - a._pubMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  function scopeItems() {
    if (state.tab === "saved") return [...state.saved.values()].sort(byNewest);
    if (CATS[state.tab]) return state.items.filter((it) => it.category === state.tab);
    return state.items;
  }

  function fillSources() {
    const sel = $("source");
    const ids = new Set(scopeItems().map((it) => it.source));
    const opts = Object.values(state.sources).filter((s) => ids.has(s.id)).sort((a, b) => a.name.localeCompare(b.name, "ru"));
    if (!ids.has(state.source)) state.source = "";
    sel.innerHTML = `<option value="">Все источники</option>` +
      opts.map((s) => `<option value="${esc(s.id)}"${s.id === state.source ? " selected" : ""}>${esc(s.name)}</option>`).join("");
  }

  function filtered(ignoreTag) {
    const q = state.q.trim().toLowerCase();
    const minMs = state.period && state.tab !== "saved" ? Date.now() - state.period * 86400e3 : 0;
    return scopeItems().filter((it) =>
      (!minMs || it._pubMs >= minMs) &&
      (!state.source || it.source === state.source) &&
      (!state.onlyNew || isNew(it)) &&
      (ignoreTag || !state.tag || it.tags.includes(state.tag)) &&
      (!q || it._search.includes(q)));
  }

  function renderTags(base) {
    const counts = Object.create(null);
    for (const it of base) {
      for (const t of it.tags) counts[t] = (counts[t] || 0) + 1;
    }
    const tags = Object.entries(counts).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0], "ru"));
    $("tag-bar").innerHTML = tags.map(([t, n]) =>
      `<button class="chip${t === state.tag ? " on" : ""}" data-tag="${esc(t)}" type="button" aria-pressed="${t === state.tag}">${esc(t)} <span class="muted">${n}</span></button>`).join("");
  }

  // ---- Склейка дублей: записи с общим group показываем одной карточкой ----
  const weight = (it) => (state.sources[it.source] || {}).weight || 1;
  // Главная запись сюжета: самый важный источник, при равенстве — кто написал первым.
  const mainFirst = (a, b) => (weight(b) - weight(a)) || (a._pubMs - b._pubMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  function groupItems(list) {
    const byKey = new Map();
    const out = [];
    for (const it of list) {
      const key = it.group || it.id;
      let g = byKey.get(key);
      if (!g) { g = { items: [] }; byKey.set(key, g); out.push(g); }
      g.items.push(it);
    }
    for (const g of out) {
      if (g.items.length > 1) g.items.sort(mainFirst);
      g.main = g.items[0];
      g.others = g.items.length > 1 ? g.items.slice(1) : [];
      // Ленты одного сайта (два раздела Хабра, блоги Google, разделы arXiv) считаем одним источником.
      g.nSources = g.items.length === 1
        ? 1
        : new Set(g.items.map((x) => (state.sources[x.source] || {}).family || x.source)).size;
    }
    // Сюжет стоит в ленте по дате главной записи — той, чьё время показано на карточке.
    out.sort((a, b) => byNewest(a.main, b.main));
    return out;
  }
  const srcName = (it) => (state.sources[it.source] || {}).name || it.source;

  function card(g) {
    const it = g.main;
    const others = g.others || [];
    const fresh = isNew(it) || others.some(isNew);
    const src = state.sources[it.source];
    const saved = state.saved.has(it.id);
    return `<li class="card" data-cat="${esc(it.category)}">
      <div class="row">
        <div class="body">
          <div class="meta">
            <span class="src">${esc(src ? src.name : it.source)}</span>
            <time datetime="${esc(it.published)}" title="${esc(formatFullDate(it._pubMs))}">${esc(ago(it._pubMs))}</time>
            ${g.nSources > 1 ? `<span class="badge-hot" title="Об этом пишут несколько источников">${g.nSources} ${plural(g.nSources, "источник", "источника", "источников")}</span>` : ""}
            ${fresh ? `<span class="badge-new">новое</span>` : ""}
          </div>
          <h3><a href="${esc(safeUrl(it.link))}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a></h3>
          ${it.summary ? `<p>${esc(it.summary)}</p>` : ""}
          ${others.length ? `<div class="also">Также: ${others.map((o) =>
            `<a href="${esc(safeUrl(o.link))}" target="_blank" rel="noopener noreferrer" title="${esc(o.title)}">${esc(srcName(o))}</a>`).join(", ")}</div>` : ""}
          ${it.tags.length ? `<div class="tags">${it.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
        </div>
        <button class="star${saved ? " on" : ""}" data-star="${esc(it.id)}" type="button"
          title="${saved ? "Убрать из избранного" : "В избранное"}" aria-label="Избранное" aria-pressed="${saved}">${saved ? "★" : "☆"}</button>
      </div>
    </li>`;
  }

  function renderNews() {
    $("period").disabled = state.tab === "saved";
    if (state.newsError && state.tab !== "saved") {
      state.lastGroups = [];
      $("tag-bar").innerHTML = "";
      $("count").textContent = "";
      $("list").innerHTML = `<li class="empty">Не удалось загрузить новости. Если вы открыли файл напрямую, запустите локальный сервер (см. README).</li>`;
      $("more").hidden = true;
      return;
    }
    const base = filtered(true);
    if (state.tag && !base.some((it) => it.tags.includes(state.tag))) state.tag = "";
    renderTags(base);
    const list = state.tag ? base.filter((it) => it.tags.includes(state.tag)) : base;
    const groups = state.tab === "saved" ? list.map((it) => ({ main: it, items: [it], others: [], nSources: 1 })) : groupItems(list);
    state.lastGroups = groups;
    const newN = groups.filter((g) => g.items.some(isNew)).length;
    const merged = list.length - groups.length;
    $("count").textContent = `${groups.length} ${plural(groups.length, "запись", "записи", "записей")}` +
      (merged ? ` · склеено дублей: ${merged}` : "") +
      (newN && !state.onlyNew ? ` · ${newN} ${plural(newN, "новая", "новые", "новых")} с прошлого визита` : "");
    $("list").innerHTML = groups.length
      ? groups.slice(0, state.shown).map(card).join("")
      : `<li class="empty">${state.tab === "saved" ? "Пока пусто — отмечайте новости звёздочкой ☆" : "Ничего не найдено. Попробуйте расширить период или сбросить фильтры."}</li>`;
    $("more").hidden = groups.length <= state.shown;
  }

  function showMore() {
    const prev = state.shown;
    state.shown += PAGE;
    const slice = state.lastGroups.slice(prev, state.shown);
    if (slice.length) $("list").insertAdjacentHTML("beforeend", slice.map(card).join(""));
    $("more").hidden = state.lastGroups.length <= state.shown;
  }

  $("q").addEventListener("input", (e) => {
    state.q = e.target.value; state.shown = PAGE;
    clearTimeout(searchTimer);
    if (!state.q) renderNews();
    else searchTimer = setTimeout(renderNews, 120);
  });
  $("period").addEventListener("change", (e) => {
    const val = Number(e.target.value);
    state.period = VALID_PERIODS.has(val) ? val : 7;
    state.shown = PAGE; store.set("period", state.period); renderNews();
  });
  $("source").addEventListener("change", (e) => { state.source = e.target.value; state.shown = PAGE; renderNews(); });
  $("only-new").addEventListener("change", (e) => { state.onlyNew = e.target.checked; state.shown = PAGE; renderNews(); });
  $("more").addEventListener("click", showMore);
  $("tag-bar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tag]"); if (!b) return;
    state.tag = state.tag === b.dataset.tag ? "" : b.dataset.tag; state.shown = PAGE; renderNews();
  });
  function onStar(e) {
    const b = e.target.closest("[data-star]"); if (!b) return;
    const id = b.dataset.star;
    const nowSaved = !state.saved.has(id);
    if (nowSaved) {
      const it = state.byId.get(id);
      if (!it) return;
      state.saved.set(id, it);
    } else {
      state.saved.delete(id);
    }
    persistSaved();
    if (state.tab === "saved") {
      renderNews();
      return;
    }
    b.classList.toggle("on", nowSaved);
    b.textContent = nowSaved ? "★" : "☆";
    b.title = nowSaved ? "Убрать из избранного" : "В избранное";
    b.setAttribute("aria-pressed", String(nowSaved));
  }
  $("list").addEventListener("click", onStar);
  $("digest-list").addEventListener("click", onStar);

  // ---- Дайджест: топ сюжетов по темам, без ИИ ----
  // Важность: сколько источников пишут + вес источника + теги. При равенстве — свежее выше.
  const TAG_SCORE = { "релиз": 2, "безопасность": 2, "модель": 1, "баг/сбой": 1, "open source": 1, "агенты": 1 };
  const DIGEST_TOP = { 1: 5, 7: 8 };      // сюжетов на тему
  const PER_SOURCE = 2;                    // не больше N сюжетов от одного источника в теме
  function score(g) {
    const tags = new Set(g.items.flatMap((x) => x.tags));
    let maxW = 1;
    for (const x of g.items) { const w = weight(x); if (w > maxW) maxW = w; }
    let tagSum = 0;
    for (const t of tags) tagSum += TAG_SCORE[t] || 0;
    return 3 * (g.nSources - 1) + 2 * (maxW - 1) + tagSum;
  }
  function digestSections() {
    const days = state.digestDays;
    const limit = DIGEST_TOP[days] || 5;
    const minMs = Date.now() - days * 86400e3;
    const recent = state.items.filter((it) => it._pubMs >= minMs);
    const groups = groupItems(recent);
    groups.forEach((g) => { g.score = score(g); });
    const sections = Object.entries(CATS).map(([cat, title]) => {
      const inCat = groups.filter((g) => g.main.category === cat)
        .sort((a, b) => (b.score - a.score) || byNewest(a.main, b.main));
      const perSrc = Object.create(null), top = [];
      for (const g of inCat) {
        if (top.length >= limit) break;
        const sid = g.main.source;
        perSrc[sid] = (perSrc[sid] || 0) + 1;
        if (perSrc[sid] > PER_SOURCE) continue;
        top.push(g);
      }
      return { cat, title, top, total: inCat.length };
    });
    return { sections, nItems: recent.length, nGroups: groups.length };
  }
  function renderDigest() {
    document.querySelectorAll("#digest-period [data-days]").forEach((b) => {
      const on = +b.dataset.days === state.digestDays;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
    if (state.newsError) {
      $("digest-note").textContent = "";
      $("digest-list").innerHTML = `<p class="empty">Не удалось загрузить новости. Если вы открыли файл напрямую, запустите локальный сервер (см. README).</p>`;
      return;
    }
    const d = digestSections();
    $("digest-note").textContent = `${d.nItems} ${plural(d.nItems, "запись", "записи", "записей")} → ` +
      `${d.nGroups} ${plural(d.nGroups, "сюжет", "сюжета", "сюжетов")} после склейки дублей. Выше — то, о чём пишут ` +
      `несколько источников, официальные блоги, релизы и безопасность.`;
    $("digest-list").innerHTML = d.sections.map((s) => `
      <h2 class="digest-h" data-cat="${esc(s.cat)}">${esc(s.title)} <span class="muted small">${s.top.length} из ${s.total}</span></h2>
      ${s.top.length ? `<ol class="list">${s.top.map(card).join("")}</ol>` : `<p class="muted small">За этот период ничего.</p>`}
      ${s.total > s.top.length ? `<a class="digest-more small" href="#${esc(s.cat)}">Вся лента «${esc(s.title)}» →</a>` : ""}`).join("");
  }
  $("digest-period").addEventListener("click", (e) => {
    const b = e.target.closest("[data-days]"); if (!b) return;
    state.digestDays = +b.dataset.days === 7 ? 7 : 1; store.set("digestDays", state.digestDays); renderDigest();
  });
  let copyTimer = 0;
  $("digest-copy").addEventListener("click", async () => {
    const d = digestSections();
    const head = `Дайджест IT/ИИ ${state.digestDays === 1 ? "за сутки" : "за неделю"} (${dtDay.format(Date.now())})`;
    const parts = d.sections.filter((s) => s.top.length).map((s) =>
      `\n${s.title}\n` + s.top.map((g) => `• ${g.main.title}${g.nSources > 1 ? ` [${g.nSources} ист.]` : ""}\n  ${g.main.link}`).join("\n"));
    const text = [head, ...parts].join("\n");
    const btn = $("digest-copy");
    try { await navigator.clipboard.writeText(text); btn.textContent = "Скопировано ✓"; }
    catch { btn.textContent = "Не удалось скопировать"; }
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { btn.textContent = "Скопировать текстом"; }, 2000);
  });

  // ---- База знаний ----
  function prepareKb(kb) {
    const secTitles = Object.fromEntries((kb.sections || []).map((s) => [s.id, s]));
    const items = (kb.items || []).map((it) => ({
      ...it,
      _search: [
        it.name, it.vendor, it.summary, it.best_for,
        ...(it.pros || []), ...(it.cons || []),
        ...(it.links || []).map((l) => l.title),
      ].filter(Boolean).join(" ").toLowerCase(),
    }));
    return { ...kb, secTitles, items };
  }

  function renderKb() {
    const kb = state.kb;
    if (!kb) { $("kb-list").innerHTML = `<p class="empty">База знаний не загрузилась.</p>`; return; }
    $("kb-sections").innerHTML = [{ id: "", title: "Все" }, ...kb.sections].map((s) =>
      `<button class="chip${s.id === state.kbSection ? " on" : ""}" data-sec="${esc(s.id)}" type="button" aria-pressed="${s.id === state.kbSection}">${esc(s.title)}</button>`).join("");
    $("kb-note").textContent = `Обновлено: ${kb.updated}. ${kb.note || ""}`;
    const q = state.kbQ.trim().toLowerCase();
    const items = kb.items.filter((it) =>
      (!state.kbSection || it.section === state.kbSection) &&
      (!q || it._search.includes(q)));
    $("kb-list").innerHTML = items.length ? items.map((it) => {
      const sec = kb.secTitles[it.section] || {};
      const list = (arr, cls) => (arr && arr.length ? `<ul class="${cls}">${arr.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
      return `<article class="kb">
        <div><h3>${esc(it.name)}</h3>${it.vendor ? `<div class="vendor">${esc(it.vendor)}</div>` : ""}</div>
        <p>${esc(it.summary)}</p>
        ${it.pros && it.pros.length ? `<h4>${esc(sec.pros_label || "Сильные стороны")}</h4>${list(it.pros, "pros")}` : ""}
        ${it.cons && it.cons.length ? `<h4>${esc(sec.cons_label || "Слабые стороны")}</h4>${list(it.cons, "cons")}` : ""}
        ${it.best_for ? `<h4>Когда выбирать</h4><p>${esc(it.best_for)}</p>` : ""}
        ${it.links && it.links.length ? `<div class="links">${it.links.map((l) => `<a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer">${esc(l.title)} ↗</a>`).join("")}</div>` : ""}
      </article>`;
    }).join("") : `<p class="empty">Ничего не найдено.</p>`;
  }
  $("kb-q").addEventListener("input", (e) => {
    state.kbQ = e.target.value;
    clearTimeout(kbSearchTimer);
    if (!state.kbQ) renderKb();
    else kbSearchTimer = setTimeout(renderKb, 120);
  });
  $("kb-sections").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sec]"); if (!b) return;
    state.kbSection = b.dataset.sec; renderKb();
  });

  // ---- Загрузка ----
  function renderStatus(data) {
    const genMs = parseMs(data.generated_at);
    $("updated").textContent = genMs ? `обновлено ${ago(genMs)}` : "";
    $("updated").title = formatFullDate(genMs);
    const bad = data.sources.filter((s) => !s.ok);
    $("sources-status").querySelector("summary").textContent =
      `Источники: ${data.sources.length}` + (bad.length ? ` (недоступно: ${bad.length})` : "");
    $("sources-list").innerHTML = data.sources.map((s) =>
      `<li class="${s.ok ? "" : "err"}">${esc(s.name)} — ${esc(CATS[s.category] || s.category)}${s.ok ? "" : " · ошибка"}</li>`).join("");
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  }

  async function load() {
    const storedPeriod = Number(store.get("period", 7));
    state.period = VALID_PERIODS.has(storedPeriod) ? storedPeriod : 7;
    state.digestDays = store.get("digestDays", 1) === 7 ? 7 : 1;
    $("period").value = String(state.period);
    const [news, kb] = await Promise.allSettled([
      fetchJson("data/news.json"),
      fetchJson("data/kb.json"),
    ]);
    if (news.status === "fulfilled" && news.value && Array.isArray(news.value.items)) {
      state.items = news.value.items.map(hydrateItem);
      state.byId = new Map(state.items.map((it) => [it.id, it]));
      state.sources = Object.fromEntries((news.value.sources || []).map((s) => [s.id, s]));
      renderStatus(news.value);
    } else {
      state.newsError = true;
    }
    if (kb.status === "fulfilled" && kb.value) state.kb = prepareKb(kb.value);
    setTab(location.hash.slice(1) || "feed", true);
  }
  load();
})();
