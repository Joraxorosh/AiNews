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
  const dtDayLabel = new Intl.DateTimeFormat("ru", { weekday: "long", day: "numeric", month: "long" });
  const dtDayMonth = new Intl.DateTimeFormat("ru", { day: "numeric", month: "long" });
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
  // Разделители дней в ленте («Сегодня», «Вчера», «Понедельник, 24 ноября»).
  const dayKey = (ms) => new Date(ms).toDateString();
  function dayLabel(ms) {
    const d = new Date(ms), today = new Date();
    const diff = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400e3);
    if (diff === 0) return "Сегодня";
    if (diff === 1) return "Вчера";
    const s = dtDayLabel.format(d);
    return s[0].toUpperCase() + s.slice(1);
  }

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

  // ---- Темы оформления (skin) — отдельно от светлой/тёмной схемы ----
  // Чтобы добавить тему: запись сюда + блок :root[data-skin="…"] в styles.css (+ шрифты в index.html).
  const SKINS = [
    { id: "default", name: "Стандартная", desc: "Чистые карточки, цветные метки тем. Удобно для быстрого просмотра ленты." },
    { id: "paper", name: "Газета", desc: "Бумажный фон, шрифты с засечками, шапка с датой выпуска, колонки и линейки. Главная новость — крупно." },
  ];
  const currentSkin = () => document.documentElement.dataset.skin || "default";
  function applySkin(id) {
    if (id === "default") delete document.documentElement.dataset.skin;
    else { document.documentElement.dataset.skin = id; if (window.__loadSkinFonts) window.__loadSkinFonts(id); }
    store.set("skin", id);
  }
  function renderThemes() {
    const cur = currentSkin();
    $("themes-list").innerHTML = SKINS.map((t) => `
      <article class="theme-card${t.id === cur ? " on" : ""}">
        <div class="preview preview-${esc(t.id)}" aria-hidden="true">
          <div class="pv-mast">AI News</div>
          <div class="pv-rule"></div>
          <div class="pv-h">Вышла новая модель</div>
          <div class="pv-line"></div><div class="pv-line short"></div>
          <div class="pv-h">Уязвимость в популярной библиотеке</div>
          <div class="pv-line"></div><div class="pv-line short"></div>
        </div>
        <h3>${esc(t.name)}</h3>
        <p class="muted small">${esc(t.desc)}</p>
        <button class="chip${t.id === cur ? " on" : ""}" data-skin="${esc(t.id)}" type="button">${t.id === cur ? "Выбрана ✓" : "Выбрать"}</button>
      </article>`).join("");
  }

  // Дата выпуска для «газетной» шапки.
  const ISSUE_START = Date.UTC(2026, 10, 25);   // 25 ноября 2026 — первый выпуск
  function renderEdition() {
    const now = new Date();
    const date = now.toLocaleDateString("ru", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const issue = Math.floor((now - ISSUE_START) / 86400e3) + 1;
    $("edition").innerHTML = `<span>${esc(date[0].toUpperCase() + date.slice(1))}</span><span>Новости IT и искусственного интеллекта</span><span>Выпуск № ${issue}</span>`;
  }

  // ---- Состояние ----
  const state = {
    tab: "feed", items: [], byId: new Map(), sources: {}, kb: null, weekly: null, reviewIdx: 0, newsError: false,
    q: "", period: 7, source: "", onlyNew: false, tag: "", shown: PAGE,
    kbQ: "", kbSection: "", kbFocus: "", digestDays: 1,
    watch: [], onlyWatch: false, hideRead: false,
    lastGroups: [],
    // Прочитанное — id открытых новостей (на этом устройстве), последние READ_MAX.
    read: new Set(Array.isArray(store.get("read", null)) ? store.get("read", []) : []),
    // Избранное хранит копии записей: так они не пропадут, когда выпадут из ленты (хранится 45 дней).
    saved: loadSaved(),
  };
  // «Новое» = появилось после предыдущего визита. Время визита обновляем один раз за загрузку.
  const prevVisitMs = parseMs(store.get("lastVisit", null));
  store.set("lastVisit", new Date().toISOString());
  const isNew = (it) => prevVisitMs > 0 && it._seenMs > prevVisitMs;
  const READ_MAX = 3000;
  const isRead = (it) => state.read.has(it.id);
  function markRead(id) {
    if (!id || state.read.has(id)) return;
    state.read.add(id);
    if (state.read.size > READ_MAX) state.read = new Set([...state.read].slice(-READ_MAX));
    store.set("read", [...state.read]);
  }

  if (!prevVisitMs) {
    const cb = $("only-new");
    cb.disabled = true;
    cb.parentElement.title = "Доступно со второго визита";
  }

  // ---- Вкладки ----
  let searchTimer = 0;
  let kbSearchTimer = 0;
  function setTab(tab, isInitial = false) {
    if (tab === "review" || tab === "trends") { state.digestDays = tab; tab = "digest"; }  // #review, #trends — сразу нужный режим
    state.kbFocus = "";
    if (tab.startsWith("kb/")) { state.kbFocus = decodeURIComponent(tab.slice(3)); tab = "kb"; }  // #kb/Gemini — одна запись
    if (!["feed", "digest", "saved", "kb", "themes", ...Object.keys(CATS)].includes(tab)) tab = "feed";
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
    $("news-view").hidden = ["kb", "digest", "themes"].includes(tab);
    $("kb-view").hidden = tab !== "kb";
    $("digest-view").hidden = tab !== "digest";
    $("themes-view").hidden = tab !== "themes";
    if ((changed || state.kbFocus) && !isInitial) window.scrollTo(0, 0);
    if (tab === "kb") renderKb();
    else if (tab === "digest") renderDigest();
    else if (tab === "themes") renderThemes();
    else { fillSources(); renderNews(); }
  }
  window.addEventListener("hashchange", () => setTab(location.hash.slice(1)));
  $("themes-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-skin]"); if (!b) return;
    applySkin(b.dataset.skin); renderThemes();
  });

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
      (!state.onlyWatch || isWatched(it)) &&
      (!state.hideRead || !isRead(it)) &&
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

  // ---- Связь с базой знаний: у записей kb.json есть шаблон match ----
  let kbMatchers = [];
  const kbHits = new Map();   // id новости -> записи базы знаний (считаем один раз)
  function initKbMatchers() {
    const order = { models: 0, tools: 1, concepts: 2 };
    kbMatchers = (state.kb ? state.kb.items : []).filter((k) => k.match).flatMap((k) => {
      try { return [{ item: k, rx: new RegExp(`(?<![\\p{L}\\d])(?:${k.match})(?![\\p{L}\\d])`, "iu") }]; }
      catch { return []; }   // старый браузер без lookbehind/\p{L} — просто без связей
    }).sort((a, b) => order[a.item.section] - order[b.item.section]);
  }
  function kbFor(it) {
    if (!kbHits.has(it.id)) {
      const hay = `${it.title} ${it.summary}`;
      kbHits.set(it.id, kbMatchers.filter((m) => m.rx.test(hay)).map((m) => m.item));
    }
    return kbHits.get(it.id);
  }
  const kbHref = (k) => `#kb/${encodeURIComponent(k.name)}`;

  // ---- Мои темы: слова, которые подсвечиваются в ленте (хранятся в браузере) ----
  const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let watchRx = null;
  function setWatch(text) {
    state.watch = text.split(",").map((w) => w.trim()).filter(Boolean);
    watchRx = state.watch.length ? new RegExp(state.watch.map((w) => reEsc(esc(w))).join("|"), "giu") : null;
  }
  const isWatched = (it) => !!watchRx && state.watch.some((w) => it._search.includes(w.toLowerCase()));
  // Подсветка по уже экранированному тексту: слова тоже экранированы, поэтому разметка не ломается.
  const hl = (text) => (watchRx ? esc(text).replace(watchRx, (m) => `<mark>${m}</mark>`) : esc(text));

  const MAX_TAGS = 3;
  function hnMeta(it) {
    if (it.points == null) return "";
    const c = it.comments || 0;
    return `<span class="hn" title="Рейтинг на Hacker News">▲ ${it.points}</span>` +
      (it.discussion ? `<a class="hn" href="${esc(safeUrl(it.discussion))}" target="_blank" rel="noopener noreferrer">${c} ${plural(c, "комментарий", "комментария", "комментариев")}</a>` : "");
  }

  function card(g, opts = {}) {
    const it = g.main;
    const others = g.others || [];
    const fresh = isNew(it) || others.some(isNew);
    const src = state.sources[it.source];
    // В общей ленте и избранном показываем тему: там перемешаны все разделы.
    const showCat = opts.showCat && CATS[it.category];
    const kbs = kbFor(it).slice(0, 3);
    const watched = isWatched(it) || others.some(isWatched);
    const saved = state.saved.has(it.id);
    const read = isRead(it) || others.some(isRead);
    return `<li class="card${opts.lead ? " lead" : ""}${watched ? " watched" : ""}${read ? " read" : ""}" data-cat="${esc(it.category)}">
      <div class="row">
        <div class="body">
          <div class="meta">
            ${showCat ? `<span class="cat">${esc(CATS[it.category])}</span>` : ""}
            <span class="src">${esc(src ? src.name : it.source)}</span>
            <time datetime="${esc(it.published)}" title="${esc(formatFullDate(it._pubMs))}">${esc(ago(it._pubMs))}</time>
            ${g.nSources > 1 ? `<span class="badge-hot" title="Об этом пишут несколько источников">${g.nSources} ${plural(g.nSources, "источник", "источника", "источников")}</span>` : ""}
            ${hnMeta(it)}
            ${fresh ? `<span class="badge-new">новое</span>` : ""}
          </div>
          <h3><a href="${esc(safeUrl(it.link))}" target="_blank" rel="noopener noreferrer" data-read="${esc(it.id)}">${hl(it.title)}</a></h3>
          ${it.summary ? `<p class="sum">${hl(it.summary)}</p>` : ""}
          ${others.length ? `<div class="also">Также: ${others.map((o) =>
            `<a href="${esc(safeUrl(o.link))}" target="_blank" rel="noopener noreferrer" title="${esc(o.title)}" data-read="${esc(o.id)}">${esc(srcName(o))}</a>`).join(", ")}</div>` : ""}
          ${it.tags.length || kbs.length ? `<div class="tags">${it.tags.slice(0, MAX_TAGS).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}${
            kbs.map((k) => `<a class="kb-link" href="${esc(kbHref(k))}" title="Открыть в базе знаний">${esc(k.name)}</a>`).join("")}</div>` : ""}
        </div>
        <button class="star${saved ? " on" : ""}" data-star="${esc(it.id)}" type="button"
          title="${saved ? "Убрать из избранного" : "В избранное"}" aria-label="Избранное" aria-pressed="${saved}">${saved ? "★" : "☆"}</button>
      </div>
    </li>`;
  }

  // Карточки для групп [from, to): разделитель дня ставим, когда день меняется относительно предыдущей группы.
  function feedHtml(groups, from, to) {
    const showCat = state.tab === "feed" || state.tab === "saved";
    let lastDay = from > 0 ? dayKey(groups[from - 1].main._pubMs) : "";
    return groups.slice(from, to).map((g, k) => {
      const day = dayKey(g.main._pubMs);
      const sep = state.tab !== "saved" && day !== lastDay ? `<li class="day-sep"><span>${esc(dayLabel(g.main._pubMs))}</span></li>` : "";
      lastDay = day;
      return sep + card(g, { showCat, lead: from + k === 0 && state.tab === "feed" });
    }).join("");
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
    const watchN = watchRx ? groups.filter((g) => g.items.some(isWatched)).length : 0;
    $("count").textContent = `${groups.length} ${plural(groups.length, "запись", "записи", "записей")}` +
      (merged ? ` · склеено дублей: ${merged}` : "") +
      (newN && !state.onlyNew ? ` · ${newN} ${plural(newN, "новая", "новые", "новых")} с прошлого визита` : "") +
      (watchN && !state.onlyWatch ? ` · ${watchN} по моим темам` : "");
    $("list").innerHTML = groups.length
      ? feedHtml(groups, 0, state.shown)
      : `<li class="empty">${state.tab === "saved" ? "Пока пусто — отмечайте новости звёздочкой ☆" : "Ничего не найдено. Попробуйте расширить период или сбросить фильтры."}</li>`;
    $("more").hidden = groups.length <= state.shown;
  }

  // «Показать ещё» дописывает карточки в конец, не перестраивая весь список.
  function showMore() {
    const prev = state.shown;
    state.shown += PAGE;
    const html = feedHtml(state.lastGroups, prev, state.shown);
    if (html) $("list").insertAdjacentHTML("beforeend", html);
    $("more").hidden = state.lastGroups.length <= state.shown;
  }

  // Перерисовываем после паузы в наборе, а не на каждую букву.
  $("q").addEventListener("input", (e) => {
    state.q = e.target.value; state.shown = PAGE;
    clearTimeout(searchTimer);
    if (!state.q) renderNews();
    else searchTimer = setTimeout(renderNews, 120);
  });
  // «/» — сразу в поиск (как на GitHub и в YouTube).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
    const box = !$("kb-view").hidden ? $("kb-q") : !$("news-view").hidden ? $("q") : null;
    if (box) { e.preventDefault(); box.focus(); }
  });
  // Лента подгружается сама, когда кнопка «Показать ещё» появляется на экране.
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      if (entries.some((en) => en.isIntersecting) && !$("more").hidden) showMore();
    }, { rootMargin: "600px" }).observe($("more"));
  }
  const toTop = $("to-top");
  window.addEventListener("scroll", () => { toTop.hidden = window.scrollY < 1200; }, { passive: true });
  toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  $("period").addEventListener("change", (e) => {
    const val = Number(e.target.value);
    state.period = VALID_PERIODS.has(val) ? val : 7;
    state.shown = PAGE; store.set("period", state.period); renderNews();
  });
  $("source").addEventListener("change", (e) => { state.source = e.target.value; state.shown = PAGE; renderNews(); });
  $("only-new").addEventListener("change", (e) => { state.onlyNew = e.target.checked; state.shown = PAGE; renderNews(); });
  $("only-watch").addEventListener("change", (e) => { state.onlyWatch = e.target.checked; state.shown = PAGE; renderNews(); });
  $("hide-read").addEventListener("change", (e) => {
    state.hideRead = e.target.checked; store.set("hideRead", state.hideRead); state.shown = PAGE; renderNews();
  });
  // Открыли новость (клик, средняя кнопка, Enter) — отмечаем прочитанной и приглушаем карточку на месте.
  function onOpen(e) {
    const a = e.target.closest("a[data-read]"); if (!a) return;
    if (e.type === "auxclick" && e.button !== 1) return;
    markRead(a.dataset.read);
    const card = a.closest(".card"); if (card) card.classList.add("read");
  }
  for (const id of ["list", "digest-list"]) {
    $(id).addEventListener("click", onOpen);
    $(id).addEventListener("auxclick", onOpen);
  }
  let wTimer = 0;
  $("watch").addEventListener("input", (e) => {
    clearTimeout(wTimer);
    wTimer = setTimeout(() => { setWatch(e.target.value); store.set("watch", e.target.value); state.shown = PAGE; renderNews(); }, 250);
  });
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
    let maxW = 1, points = 0;
    for (const x of g.items) {
      const w = weight(x); if (w > maxW) maxW = w;
      if ((x.points || 0) > points) points = x.points;
    }
    let tagSum = 0;
    for (const t of tags) tagSum += TAG_SCORE[t] || 0;
    return 3 * (g.nSources - 1) + 2 * (maxW - 1) + tagSum +
      (points >= 800 ? 3 : points >= 300 ? 2 : 0);   // горячее обсуждение на Hacker News
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
  // ---- Тренды: сколько сюжетов упоминают модель/инструмент/понятие, по дням ----
  const TREND_DAYS = 14;
  const TREND_TOP = 8;
  function trendsData() {
    const today = new Date(new Date().toDateString()).getTime();
    const start = today - (TREND_DAYS - 1) * 86400e3;
    const dayIdx = (ms) => Math.round((new Date(new Date(ms).toDateString()).getTime() - start) / 86400e3);
    const per = new Map();   // запись базы знаний -> массив множеств сюжетов по дням
    let firstMs = Infinity;
    for (const it of state.items) {
      // Статьи arXiv и автоматические релизы с GitHub (gh-*) заглушили бы то, о чём пишут люди.
      if (it.source.startsWith("arxiv") || it.source.startsWith("gh-")) continue;
      const d = dayIdx(it._pubMs);
      if (d < 0 || d >= TREND_DAYS) continue;
      if (it._pubMs < firstMs) firstMs = it._pubMs;
      const key = it.group || it.id;
      for (const k of kbFor(it)) {
        if (!per.has(k)) per.set(k, Array.from({ length: TREND_DAYS }, () => new Set()));
        per.get(k)[d].add(key);
      }
    }
    const rows = [...per.entries()].map(([k, days]) => {
      const counts = days.map((set) => set.size);
      const week = counts.slice(-7).reduce((a, b) => a + b, 0);
      const prev = counts.slice(-14, -7).reduce((a, b) => a + b, 0);
      return { k, counts, week, prev, total: week + prev };
    }).filter((r) => r.week > 0);
    const bySection = (sec) => rows.filter((r) => r.k.section === sec)
      .sort((a, b) => (b.week - a.week) || (b.total - a.total) || a.k.name.localeCompare(b.k.name)).slice(0, TREND_TOP);
    return { start, firstMs, sections: [["models", "Модели"], ["tools", "Инструменты"], ["concepts", "Понятия"]].map(([id, title]) => ({ id, title, rows: bySection(id) })) };
  }
  // Мини-график: TREND_DAYS столбиков, общий масштаб внутри раздела, подсказка на каждом столбике.
  function sparkSvg(counts, max, start) {
    const W = 8, GAP = 2, H = 30, n = counts.length;
    const bars = counts.map((c, i) => {
      const h = c ? Math.max(3, Math.round((c / max) * H)) : 0;
      const x = i * (W + GAP);
      const date = dtDayLabel.format(new Date(start + i * 86400e3));
      const tip = `${date}: ${c} ${plural(c, "сюжет", "сюжета", "сюжетов")}`;
      return `<g><title>${esc(tip)}</title><rect class="hit" x="${x}" y="0" width="${W + GAP}" height="${H}"></rect>` +
        (h ? `<path class="bar${i >= n - 7 ? " recent" : ""}" d="M${x},${H} v-${h - 3} q0,-3 3,-3 h${W - 6} q3,0 3,3 v${h - 3} z"></path>` : "") + `</g>`;
    }).join("");
    return `<svg class="spark" viewBox="0 0 ${n * (W + GAP) - GAP} ${H}" width="${n * (W + GAP) - GAP}" height="${H}" role="img" aria-label="Сюжеты по дням">${bars}<line class="base" x1="0" y1="${H}" x2="${n * (W + GAP)}" y2="${H}"></line></svg>`;
  }
  function renderTrends() {
    const t = trendsData();
    const since = Number.isFinite(t.firstMs) ? dtDayMonth.format(t.firstMs) : "";
    $("digest-note").textContent = `Сколько сюжетов за ${TREND_DAYS} дней упоминают модели, инструменты и понятия из базы знаний ` +
      `(дубли склеены, без arXiv и автоматических релизов GitHub). Яркие столбики — последние 7 дней.` + (since && t.firstMs > t.start ? ` Лента собирается с ${since}.` : "");
    $("digest-list").innerHTML = t.sections.map((sec) => {
      if (!sec.rows.length) return "";
      const max = Math.max(...sec.rows.flatMap((r) => r.counts), 1);
      return `<h2 class="digest-h">${esc(sec.title)}</h2>
        <table class="trends"><colgroup><col><col class="c-spark"><col class="c-num"><col class="c-delta"></colgroup><thead><tr><th>Название</th><th>По дням</th><th class="num">7 дней</th><th class="num">К прошлой неделе</th></tr></thead><tbody>
        ${sec.rows.map((r) => {
          const d = r.week - r.prev;
          return `<tr>
            <td><a href="${esc(kbHref(r.k))}">${esc(r.k.name)}</a></td>
            <td>${sparkSvg(r.counts, max, t.start)}</td>
            <td class="num"><b>${r.week}</b></td>
            <td class="num delta">${d > 0 ? `↑︎ +${d}` : d < 0 ? `↓︎ −${-d}` : "="}</td>
          </tr>`;
        }).join("")}</tbody></table>`;
    }).join("") || `<p class="empty">Пока мало данных для трендов.</p>`;
  }

  // ---- Обзор недели: связный текст на русском из data/weekly.json (пишется вручную) ----
  function renderReview() {
    const issues = (state.weekly && state.weekly.issues) || [];
    if (!issues.length) {
      $("digest-note").textContent = "";
      $("digest-list").innerHTML = `<p class="empty">Обзоров пока нет.</p>`;
      return;
    }
    const idx = Math.min(state.reviewIdx, issues.length - 1);
    const is = issues[idx];
    $("digest-note").innerHTML = issues.length > 1
      ? `<label>Выпуск: <select id="review-pick">${issues.map((x, i) =>
          `<option value="${i}"${i === idx ? " selected" : ""}>${esc(x.title)}</option>`).join("")}</select></label>`
      : `Опубликовано ${esc(new Date(is.published).toLocaleDateString("ru", { day: "numeric", month: "long", year: "numeric" }))}`;
    $("digest-list").innerHTML = `<article class="review">
      <h2 class="review-title">${esc(is.title)}</h2>
      <p class="review-intro">${esc(is.intro)}</p>
      ${is.sections.map((sec) => `
        <h3 class="review-h">${esc(sec.title)}</h3>
        <ul class="review-points">${sec.points.map((pt) => `<li>
          <p>${esc(pt.text)}</p>
          ${pt.links && pt.links.length ? `<div class="review-links">${pt.links.map((l) =>
            `<a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer">${esc(l.title)}</a>`).join("")}</div>` : ""}
        </li>`).join("")}</ul>`).join("")}
    </article>`;
  }
  const reviewText = (is) => [is.title, "", is.intro, ...is.sections.map((sec) =>
    `\n${sec.title}\n` + sec.points.map((pt) => `• ${pt.text}` + (pt.links && pt.links[0] ? `\n  ${pt.links[0].url}` : "")).join("\n"))].join("\n");

  function renderDigest() {
    document.querySelectorAll("#digest-period [data-days]").forEach((b) => {
      const on = b.dataset.days === String(state.digestDays);
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
    if (state.digestDays === "review") { renderReview(); return; }
    if (state.digestDays === "trends") { renderTrends(); return; }
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
      ${s.top.length ? `<ol class="list">${s.top.map((g) => card(g)).join("")}</ol>` : `<p class="muted small">За этот период ничего.</p>`}
      ${s.total > s.top.length ? `<a class="digest-more small" href="#${esc(s.cat)}">Вся лента «${esc(s.title)}» →</a>` : ""}`).join("");
  }
  $("digest-period").addEventListener("click", (e) => {
    const b = e.target.closest("[data-days]"); if (!b) return;
    state.digestDays = ["review", "trends"].includes(b.dataset.days) ? b.dataset.days : +b.dataset.days === 7 ? 7 : 1;
    store.set("digestDays", state.digestDays); renderDigest();
  });
  $("digest-note").addEventListener("change", (e) => {
    if (e.target.id === "review-pick") { state.reviewIdx = +e.target.value; renderReview(); }
  });
  $("digest-copy").addEventListener("click", async () => {
    if (state.digestDays === "trends") {
      const t = trendsData();
      return copyText([`Тренды IT/ИИ за ${TREND_DAYS} дней (${dtDay.format(Date.now())}), сюжетов за 7 дней:`,
        ...t.sections.filter((x) => x.rows.length).map((x) => `\n${x.title}\n` + x.rows.map((r) => {
          const d = r.week - r.prev;
          return `• ${r.k.name}: ${r.week} (${d > 0 ? "+" + d : d < 0 ? "−" + -d : "без изменений"})`;
        }).join("\n"))].join("\n"));
    }
    if (state.digestDays === "review") {
      const issues = (state.weekly && state.weekly.issues) || [];
      if (!issues.length) return;
      return copyText(reviewText(issues[Math.min(state.reviewIdx, issues.length - 1)]));
    }
    const d = digestSections();
    const head = `Дайджест IT/ИИ ${state.digestDays === 1 ? "за сутки" : "за неделю"} (${dtDay.format(Date.now())})`;
    const parts = d.sections.filter((s) => s.top.length).map((s) =>
      `\n${s.title}\n` + s.top.map((g) => `• ${g.main.title}${g.nSources > 1 ? ` [${g.nSources} ист.]` : ""}\n  ${g.main.link}`).join("\n"));
    copyText([head, ...parts].join("\n"));
  });
  let copyTimer = 0;
  async function copyText(text) {
    const btn = $("digest-copy");
    try { await navigator.clipboard.writeText(text); btn.textContent = "Скопировано ✓"; }
    catch { btn.textContent = "Не удалось скопировать"; }
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { btn.textContent = "Скопировать текстом"; }, 2000);
  }

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
    $("kb-focus").hidden = !state.kbFocus;
    $("kb-list").classList.toggle("focus", !!state.kbFocus);
    const items = state.kbFocus ? kb.items.filter((it) => it.name === state.kbFocus) : kb.items.filter((it) =>
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
        ${kbNews(it)}
        ${it.links && it.links.length ? `<div class="links">${it.links.map((l) => `<a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer">${esc(l.title)} ↗</a>`).join("")}</div>` : ""}
      </article>`;
    }).join("") : `<p class="empty">Ничего не найдено.</p>`;
  }
  // «Последние новости» в карточке базы знаний — из ленты, по тому же шаблону match.
  function kbNews(k) {
    if (!k.match) return "";
    const n = state.kbFocus ? 8 : 3;
    const seen = new Set();
    const news = state.items.filter((it) => {
      if (!kbFor(it).includes(k)) return false;
      const key = it.group || it.id;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, n);
    if (!news.length) return "";
    return `<h4>Последние новости</h4><ul class="kb-news">${news.map((it) =>
      `<li><a href="${esc(safeUrl(it.link))}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a> <span class="muted">${esc(ago(it._pubMs))}</span></li>`).join("")}</ul>` +
      (!state.kbFocus ? `<a class="small kb-more" href="${esc(kbHref(k))}">Подробнее и больше новостей →</a>` : "");
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
    renderEdition();
    const storedPeriod = Number(store.get("period", 7));
    state.period = VALID_PERIODS.has(storedPeriod) ? storedPeriod : 7;
    const dd = store.get("digestDays", 1);
    state.digestDays = [7, "review", "trends"].includes(dd) ? dd : 1;
    state.hideRead = store.get("hideRead", false) === true;
    $("hide-read").checked = state.hideRead;
    $("period").value = String(state.period);
    const [news, kb, weekly] = await Promise.allSettled([
      fetchJson("data/news.json"),
      fetchJson("data/kb.json"),
      fetchJson("data/weekly.json"),
    ]);
    if (weekly.status === "fulfilled") state.weekly = weekly.value;
    if (news.status === "fulfilled" && news.value && Array.isArray(news.value.items)) {
      state.items = news.value.items.map(hydrateItem);
      state.byId = new Map(state.items.map((it) => [it.id, it]));
      state.sources = Object.fromEntries((news.value.sources || []).map((s) => [s.id, s]));
      renderStatus(news.value);
    } else {
      state.newsError = true;
    }
    if (kb.status === "fulfilled" && kb.value) { state.kb = prepareKb(kb.value); initKbMatchers(); }
    const w = store.get("watch", "");
    $("watch").value = w; setWatch(w);
    setTab(location.hash.slice(1) || "feed", true);
    if (!navigator.onLine) $("updated").textContent = "нет сети — сохранённые новости";
  }
  load();

  // Установка как приложение и работа без сети (sw.js). Только по https или на localhost.
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => { /* без офлайна — не страшно */ }));
  }
})();
