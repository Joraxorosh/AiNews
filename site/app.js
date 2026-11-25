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

  // ---- Состояние ----
  const state = {
    tab: "feed", items: [], sources: {}, kb: null,
    q: "", period: 7, source: "", onlyNew: false, tag: "", shown: PAGE,
    kbQ: "", kbSection: "",
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

  // ---- Вкладки ----
  function setTab(tab) {
    if (!["feed", "saved", "kb", ...Object.keys(CATS)].includes(tab)) tab = "feed";
    state.tab = tab; state.shown = PAGE; state.tag = "";
    document.querySelectorAll("#tabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
    $("news-view").hidden = tab === "kb";
    $("kb-view").hidden = tab !== "kb";
    if (tab === "kb") renderKb(); else { fillSources(); renderNews(); }
  }
  window.addEventListener("hashchange", () => setTab(location.hash.slice(1)));

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

  function card(it) {
    const src = state.sources[it.source];
    return `<li class="card" data-cat="${esc(it.category)}">
      <div class="row">
        <div class="body">
          <div class="meta">
            <span class="src">${esc(src ? src.name : it.source)}</span>
            <time datetime="${esc(it.published)}" title="${esc(new Date(it.published).toLocaleString("ru"))}">${esc(ago(it.published))}</time>
            ${isNew(it) ? `<span class="badge-new">новое</span>` : ""}
          </div>
          <h3><a href="${esc(safeUrl(it.link))}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a></h3>
          ${it.summary ? `<p>${esc(it.summary)}</p>` : ""}
          ${it.tags.length ? `<div class="tags">${it.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
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
    const newN = list.filter(isNew).length;
    $("count").textContent = `${list.length} записей` + (newN && !state.onlyNew ? ` · ${newN} новых с прошлого визита` : "");
    $("list").innerHTML = list.length
      ? list.slice(0, state.shown).map(card).join("")
      : `<li class="empty">${state.tab === "saved" ? "Пока пусто — отмечайте новости звёздочкой ☆" : "Ничего не найдено. Попробуйте расширить период или сбросить фильтры."}</li>`;
    $("more").hidden = list.length <= state.shown;
    $("period").disabled = state.tab === "saved";
  }

  $("q").addEventListener("input", (e) => { state.q = e.target.value; state.shown = PAGE; renderNews(); });
  $("period").addEventListener("change", (e) => { state.period = +e.target.value; state.shown = PAGE; store.set("period", state.period); renderNews(); });
  $("source").addEventListener("change", (e) => { state.source = e.target.value; state.shown = PAGE; renderNews(); });
  $("only-new").addEventListener("change", (e) => { state.onlyNew = e.target.checked; state.shown = PAGE; renderNews(); });
  $("more").addEventListener("click", () => { state.shown += PAGE; renderNews(); });
  $("tag-bar").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tag]"); if (!b) return;
    state.tag = state.tag === b.dataset.tag ? "" : b.dataset.tag; state.shown = PAGE; renderNews();
  });
  $("list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-star]"); if (!b) return;
    const id = b.dataset.star;
    if (state.saved.has(id)) state.saved.delete(id);
    else { const it = state.items.find((x) => x.id === id); if (it) state.saved.set(id, it); }
    store.set("savedItems", Object.fromEntries(state.saved));
    renderNews();
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
    state.period = store.get("period", 7);
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
