(() => {
  "use strict";

  const PAGE = 50;
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
    tab: "feed", items: [], sources: {}, kb: null,
    q: "", period: 7, source: "", onlyNew: false, tag: "", shown: PAGE,
    kbQ: "", kbSection: "", digestDays: 1,
    // Избранное хранит копии записей: так они не пропадут, когда выпадут из ленты (хранится 45 дней).
    saved: new Map(Object.entries(store.get("savedItems", {}))),
  };
  // «Новое» = появилось после предыдущего визита. Время визита обновляем один раз за загрузку.
  const prevVisit = store.get("lastVisit", null);
  store.set("lastVisit", new Date().toISOString());

  // ---- Утилиты ----
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");
  const rtf = new Intl.RelativeTimeFormat("ru", { numeric: "auto" });
  function ago(iso) {
    const diff = (new Date(iso) - Date.now()) / 1000;
    if (Math.abs(diff) < 60) return "только что";
    if (Math.abs(diff) < 3600) return rtf.format(Math.round(diff / 60), "minute");
    if (Math.abs(diff) < 86400) return rtf.format(Math.round(diff / 3600), "hour");
    if (Math.abs(diff) < 86400 * 7) return rtf.format(Math.round(diff / 86400), "day");
    return new Date(iso).toLocaleDateString("ru", { day: "numeric", month: "short", year: "numeric" });
  }
  const isNew = (it) => prevVisit && it.first_seen > prevVisit;
  const dayKey = (iso) => new Date(iso).toDateString();
  function dayLabel(iso) {
    const d = new Date(iso), today = new Date();
    const diff = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400e3);
    if (diff === 0) return "Сегодня";
    if (diff === 1) return "Вчера";
    const s = d.toLocaleDateString("ru", { weekday: "long", day: "numeric", month: "long" });
    return s[0].toUpperCase() + s.slice(1);
  }

  // ---- Вкладки ----
  function setTab(tab) {
    if (!["feed", "digest", "saved", "kb", "themes", ...Object.keys(CATS)].includes(tab)) tab = "feed";
    state.tab = tab; state.shown = PAGE; state.tag = "";
    document.querySelectorAll("#tabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
    $("news-view").hidden = ["kb", "digest", "themes"].includes(tab);
    $("kb-view").hidden = tab !== "kb";
    $("digest-view").hidden = tab !== "digest";
    $("themes-view").hidden = tab !== "themes";
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
  function scopeItems() {
    if (state.tab === "saved") return [...state.saved.values()].sort((a, b) => (a.published < b.published ? 1 : -1));
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
    const minDate = state.period && state.tab !== "saved" ? new Date(Date.now() - state.period * 86400e3).toISOString() : "";
    return scopeItems().filter((it) =>
      (!minDate || it.published >= minDate) &&
      (!state.source || it.source === state.source) &&
      (!state.onlyNew || isNew(it)) &&
      (ignoreTag || !state.tag || it.tags.includes(state.tag)) &&
      (!q || (it.title + " " + it.summary).toLowerCase().includes(q)));
  }

  function renderTags(base) {
    const counts = {};
    base.forEach((it) => it.tags.forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
    const tags = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    $("tag-bar").innerHTML = tags.map(([t, n]) =>
      `<button class="chip${t === state.tag ? " on" : ""}" data-tag="${esc(t)}" type="button">${esc(t)} <span class="muted">${n}</span></button>`).join("");
  }

  // ---- Склейка дублей: записи с общим group показываем одной карточкой ----
  const weight = (it) => (state.sources[it.source] || {}).weight || 1;
  // Главная запись сюжета: самый важный источник, при равенстве — кто написал первым.
  const mainFirst = (a, b) => weight(b) - weight(a) || (a.published < b.published ? -1 : 1);
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
      g.items.sort(mainFirst);
      g.main = g.items[0];
      g.others = g.items.slice(1);
      // Ленты одного сайта (два раздела Хабра, блоги Google) считаем одним источником.
      g.nSources = new Set(g.items.map((x) => (state.sources[x.source] || {}).family || x.source)).size;
    }
    // Сюжет стоит в ленте по дате главной записи — той, чьё время показано на карточке.
    out.sort((a, b) => (a.main.published < b.main.published ? 1 : -1));
    return out;
  }
  const srcName = (it) => (state.sources[it.source] || {}).name || it.source;
  const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  };

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
    return `<li class="card${opts.lead ? " lead" : ""}" data-cat="${esc(it.category)}">
      <div class="row">
        <div class="body">
          <div class="meta">
            ${showCat ? `<span class="cat">${esc(CATS[it.category])}</span>` : ""}
            <span class="src">${esc(src ? src.name : it.source)}</span>
            <time datetime="${esc(it.published)}" title="${esc(new Date(it.published).toLocaleString("ru"))}">${esc(ago(it.published))}</time>
            ${g.nSources > 1 ? `<span class="badge-hot" title="Об этом пишут несколько источников">${g.nSources} ${plural(g.nSources, "источник", "источника", "источников")}</span>` : ""}
            ${hnMeta(it)}
            ${fresh ? `<span class="badge-new">новое</span>` : ""}
          </div>
          <h3><a href="${esc(safeUrl(it.link))}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a></h3>
          ${it.summary ? `<p class="sum">${esc(it.summary)}</p>` : ""}
          ${others.length ? `<div class="also">Также: ${others.map((o) =>
            `<a href="${esc(safeUrl(o.link))}" target="_blank" rel="noopener noreferrer" title="${esc(o.title)}">${esc(srcName(o))}</a>`).join(", ")}</div>` : ""}
          ${it.tags.length ? `<div class="tags">${it.tags.slice(0, MAX_TAGS).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
        </div>
        <button class="star${state.saved.has(it.id) ? " on" : ""}" data-star="${esc(it.id)}" type="button"
          title="${state.saved.has(it.id) ? "Убрать из избранного" : "В избранное"}" aria-label="Избранное">${state.saved.has(it.id) ? "★" : "☆"}</button>
      </div>
    </li>`;
  }

  function renderNews() {
    const base = filtered(true);
    if (state.tag && !base.some((it) => it.tags.includes(state.tag))) state.tag = "";
    renderTags(base);
    const list = state.tag ? base.filter((it) => it.tags.includes(state.tag)) : base;
    const groups = state.tab === "saved" ? list.map((it) => ({ main: it, items: [it], others: [], nSources: 1 })) : groupItems(list);
    const newN = groups.filter((g) => g.items.some(isNew)).length;
    const merged = list.length - groups.length;
    $("count").textContent = `${groups.length} записей` + (merged ? ` · склеено дублей: ${merged}` : "") +
      (newN && !state.onlyNew ? ` · ${newN} новых с прошлого визита` : "");
    const showCat = state.tab === "feed" || state.tab === "saved";
    let lastDay = "";
    const html = groups.slice(0, state.shown).map((g, i) => {
      const day = dayKey(g.main.published);
      const sep = state.tab !== "saved" && day !== lastDay ? `<li class="day-sep"><span>${esc(dayLabel(g.main.published))}</span></li>` : "";
      lastDay = day;
      return sep + card(g, { showCat, lead: i === 0 && state.tab === "feed" });
    }).join("");
    $("list").innerHTML = groups.length
      ? html
      : `<li class="empty">${state.tab === "saved" ? "Пока пусто — отмечайте новости звёздочкой ☆" : "Ничего не найдено. Попробуйте расширить период или сбросить фильтры."}</li>`;
    $("more").hidden = groups.length <= state.shown;
    $("period").disabled = state.tab === "saved";
  }

  let qTimer = 0;  // перерисовываем после паузы в наборе, а не на каждую букву
  $("q").addEventListener("input", (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.q = e.target.value; state.shown = PAGE; renderNews(); }, 150);
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
      if (entries.some((en) => en.isIntersecting) && !$("more").hidden) { state.shown += PAGE; renderNews(); }
    }, { rootMargin: "600px" }).observe($("more"));
  }
  const toTop = $("to-top");
  window.addEventListener("scroll", () => { toTop.hidden = window.scrollY < 1200; }, { passive: true });
  toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  $("period").addEventListener("change", (e) => { state.period = +e.target.value; state.shown = PAGE; store.set("period", state.period); renderNews(); });
  $("source").addEventListener("change", (e) => { state.source = e.target.value; state.shown = PAGE; renderNews(); });
  $("only-new").addEventListener("change", (e) => { state.onlyNew = e.target.checked; state.shown = PAGE; renderNews(); });
  $("more").addEventListener("click", () => { state.shown += PAGE; renderNews(); });
  $("tag-bar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tag]"); if (!b) return;
    state.tag = state.tag === b.dataset.tag ? "" : b.dataset.tag; state.shown = PAGE; renderNews();
  });
  function onStar(e) {
    const b = e.target.closest("[data-star]"); if (!b) return;
    const id = b.dataset.star;
    if (state.saved.has(id)) state.saved.delete(id);
    else { const it = state.items.find((x) => x.id === id); if (it) state.saved.set(id, it); }
    store.set("savedItems", Object.fromEntries(state.saved));
    if (state.tab === "digest") renderDigest(); else renderNews();
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
    const points = Math.max(0, ...g.items.map((x) => x.points || 0));
    return 3 * (g.nSources - 1) + 2 * (Math.max(...g.items.map(weight)) - 1) +
      [...tags].reduce((sum, t) => sum + (TAG_SCORE[t] || 0), 0) +
      (points >= 800 ? 3 : points >= 300 ? 2 : 0);   // горячее обсуждение на Hacker News
  }
  function digestSections() {
    const days = state.digestDays;
    const minDate = new Date(Date.now() - days * 86400e3).toISOString();
    const recent = state.items.filter((it) => it.published >= minDate);
    const groups = groupItems(recent);
    groups.forEach((g) => { g.score = score(g); });
    const sections = Object.entries(CATS).map(([cat, title]) => {
      const inCat = groups.filter((g) => g.main.category === cat)
        .sort((a, b) => b.score - a.score || (a.main.published < b.main.published ? 1 : -1));
      const perSrc = {}, top = [];
      for (const g of inCat) {
        if (top.length >= DIGEST_TOP[days]) break;
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
    document.querySelectorAll("#digest-period [data-days]").forEach((b) => b.classList.toggle("on", +b.dataset.days === state.digestDays));
    const d = digestSections();
    $("digest-note").textContent = `${d.nItems} записей → ${d.nGroups} сюжетов после склейки дублей. Выше — то, о чём пишут ` +
      `несколько источников, официальные блоги, релизы и безопасность.`;
    $("digest-list").innerHTML = d.sections.map((s) => `
      <h2 class="digest-h" data-cat="${esc(s.cat)}">${esc(s.title)} <span class="muted small">${s.top.length} из ${s.total}</span></h2>
      ${s.top.length ? `<ol class="list">${s.top.map((g) => card(g)).join("")}</ol>` : `<p class="muted small">За этот период ничего.</p>`}
      ${s.total > s.top.length ? `<a class="digest-more small" href="#${esc(s.cat)}">Вся лента «${esc(s.title)}» →</a>` : ""}`).join("");
  }
  $("digest-period").addEventListener("click", (e) => {
    const b = e.target.closest("[data-days]"); if (!b) return;
    state.digestDays = +b.dataset.days; store.set("digestDays", state.digestDays); renderDigest();
  });
  $("digest-copy").addEventListener("click", async () => {
    const d = digestSections();
    const head = `Дайджест IT/ИИ ${state.digestDays === 1 ? "за сутки" : "за неделю"} (${new Date().toLocaleDateString("ru")})`;
    const parts = d.sections.filter((s) => s.top.length).map((s) =>
      `\n${s.title}\n` + s.top.map((g) => `• ${g.main.title}${g.nSources > 1 ? ` [${g.nSources} ист.]` : ""}\n  ${g.main.link}`).join("\n"));
    const text = [head, ...parts].join("\n");
    const btn = $("digest-copy");
    try { await navigator.clipboard.writeText(text); btn.textContent = "Скопировано ✓"; }
    catch { btn.textContent = "Не удалось скопировать"; }
    setTimeout(() => { btn.textContent = "Скопировать текстом"; }, 2000);
  });

  // ---- База знаний ----
  function renderKb() {
    const kb = state.kb;
    if (!kb) { $("kb-list").innerHTML = `<p class="empty">База знаний не загрузилась.</p>`; return; }
    $("kb-sections").innerHTML = [{ id: "", title: "Все" }, ...kb.sections].map((s) =>
      `<button class="chip${s.id === state.kbSection ? " on" : ""}" data-sec="${esc(s.id)}" type="button">${esc(s.title)}</button>`).join("");
    $("kb-note").textContent = `Обновлено: ${kb.updated}. ${kb.note || ""}`;
    const q = state.kbQ.trim().toLowerCase();
    const secTitles = Object.fromEntries(kb.sections.map((s) => [s.id, s]));
    const items = kb.items.filter((it) =>
      (!state.kbSection || it.section === state.kbSection) &&
      (!q || JSON.stringify(it).toLowerCase().includes(q)));
    $("kb-list").innerHTML = items.length ? items.map((it) => {
      const sec = secTitles[it.section] || {};
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
  $("kb-q").addEventListener("input", (e) => { state.kbQ = e.target.value; renderKb(); });
  $("kb-sections").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sec]"); if (!b) return;
    state.kbSection = b.dataset.sec; renderKb();
  });

  // ---- Загрузка ----
  function renderStatus(data) {
    $("updated").textContent = `обновлено ${ago(data.generated_at)}`;
    $("updated").title = new Date(data.generated_at).toLocaleString("ru");
    const bad = data.sources.filter((s) => !s.ok);
    $("sources-status").querySelector("summary").textContent =
      `Источники: ${data.sources.length}` + (bad.length ? ` (недоступно: ${bad.length})` : "");
    $("sources-list").innerHTML = data.sources.map((s) =>
      `<li class="${s.ok ? "" : "err"}">${esc(s.name)} — ${esc(CATS[s.category] || s.category)}${s.ok ? "" : " · ошибка"}</li>`).join("");
  }

  async function load() {
    renderEdition();
    state.period = store.get("period", 7);
    state.digestDays = store.get("digestDays", 1) === 7 ? 7 : 1;
    $("period").value = String(state.period);
    const [news, kb] = await Promise.allSettled([
      fetch("data/news.json", { cache: "no-cache" }).then((r) => r.json()),
      fetch("data/kb.json", { cache: "no-cache" }).then((r) => r.json()),
    ]);
    if (news.status === "fulfilled") {
      state.items = news.value.items;
      state.sources = Object.fromEntries(news.value.sources.map((s) => [s.id, s]));
      renderStatus(news.value);
    } else {
      $("list").innerHTML = `<li class="empty">Не удалось загрузить новости. Если вы открыли файл напрямую, запустите локальный сервер (см. README).</li>`;
    }
    if (kb.status === "fulfilled") state.kb = kb.value;
    setTab(location.hash.slice(1) || "feed");
  }
  load();
})();
