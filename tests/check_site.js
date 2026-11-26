// Проверка данных сайта: JSON-файлы, структура обзоров, шаблоны базы знаний (как RegExp браузера).
// Запуск: node tests/check_site.js   (код возврата 1 — есть ошибки)
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const errors = [];
const fail = (msg) => errors.push(msg);
const readJson = (rel) => {
  try { return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8")); }
  catch (e) { fail(`${rel}: не читается как JSON — ${e.message}`); return null; }
};
const isUrl = (u) => typeof u === "string" && /^https:\/\//.test(u);

// База знаний
const kb = readJson("site/data/kb.json");
if (kb) {
  const sections = new Set((kb.sections || []).map((s) => s.id));
  const names = new Set();
  for (const it of kb.items || []) {
    const where = `kb.json «${it.name}»`;
    if (!it.name || !it.summary) fail(`${where}: нет name/summary`);
    if (names.has(it.name)) fail(`${where}: повтор названия`);
    names.add(it.name);
    if (!sections.has(it.section)) fail(`${where}: неизвестный раздел ${it.section}`);
    for (const l of it.links || []) if (!isUrl(l.url) || !l.title) fail(`${where}: плохая ссылка ${JSON.stringify(l)}`);
    if (it.match) {
      try {
        const rx = new RegExp(`(?<![\\p{L}\\d])(?:${it.match})(?![\\p{L}\\d])`, "iu");
        if (rx.test("")) fail(`${where}: шаблон match совпадает с пустой строкой`);
      } catch (e) { fail(`${where}: шаблон match не компилируется — ${e.message}`); }
    }
  }
}

// Обзоры недели
const weekly = readJson("site/data/weekly.json");
if (weekly) {
  const ids = new Set();
  for (const is of weekly.issues || []) {
    const where = `weekly.json «${is.id}»`;
    for (const k of ["id", "title", "published", "intro"]) if (!is[k]) fail(`${where}: нет поля ${k}`);
    if (ids.has(is.id)) fail(`${where}: повтор id`);
    ids.add(is.id);
    for (const sec of is.sections || []) {
      if (!sec.title || !(sec.points || []).length) fail(`${where}: пустой раздел «${sec.title}»`);
      for (const pt of sec.points || []) {
        if (!pt.text) fail(`${where}: пункт без текста`);
        for (const l of pt.links || []) if (!isUrl(l.url) || !l.title) fail(`${where}: плохая ссылка ${JSON.stringify(l)}`);
      }
    }
  }
}

// Новости и источники
const news = readJson("site/data/news.json");
if (news && !Array.isArray(news.items)) fail("news.json: нет массива items");
readJson("sources.json");

if (errors.length) {
  console.error(`Ошибок: ${errors.length}\n  ` + errors.join("\n  "));
  process.exit(1);
}
console.log(`OK: kb ${kb.items.length} записей, обзоров ${weekly.issues.length}, новостей ${news.items.length}`);
