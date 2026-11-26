"""Собирает новости из RSS/Atom-источников (sources.json) в site/data/news.json.

Только стандартная библиотека Python 3.11+. Новые записи сливаются с уже
сохранёнными, так что история накапливается между запусками.

Запуск:  python scripts/fetch_news.py
"""
from __future__ import annotations

import hashlib
import html
import json
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES_FILE = ROOT / "sources.json"
OUT_FILE = ROOT / "site" / "data" / "news.json"

USER_AGENT = "Mozilla/5.0 (compatible; AiNewsAggregator/1.0)"
TIMEOUT = 25
DEFAULT_MAX_ITEMS = 25
KEEP_DAYS = 45
MAX_TOTAL = 4000
SUMMARY_LEN = 320

# Автотеги по ключевым словам (en + ru). Порядок = порядок отображения.
TAG_RULES: list[tuple[str, re.Pattern]] = [
    ("модель", re.compile(r"\b(gpt-?\d|o\d\b|claude|gemini|gemma|llama|mistral|mixtral|qwen|deepseek|grok|phi-?\d|"
                         r"model|модел|llm|weights)\w*", re.I)),
    ("релиз", re.compile(r"\b(release[sd]?|launch\w*|introduc\w+|announc\w+|now available|general availability|"
                        r"релиз\w*|выпус\w*|представил\w*|запуст\w*|v\d+\.\d+)", re.I)),
    ("безопасность", re.compile(r"\b(cve-\d+|vulnerab\w*|exploit\w*|zero-day|0-day|malware|ransomware|breach\w*|"
                               r"phishing|backdoor|уязвим\w*|взлом\w*|утечк\w*|вредонос\w*)", re.I)),
    ("баг/сбой", re.compile(r"\b(bug\w*|outage\w*|incident\w*|regression\w*|crash\w*|downtime|deprecat\w*|"
                           r"сбо[йя]\w*|ошибк\w*|баг\w*)", re.I)),
    ("open source", re.compile(r"\b(open[- ]source|open[- ]weight\w*|apache 2|mit licen\w*|открыт\w* (код|вес)\w*)", re.I)),
    ("агенты", re.compile(r"\b(agent\w*|agentic|mcp|агент\w*)", re.I)),
    ("API/цены", re.compile(r"\b(api|pricing|price\w*|rate limit\w*|цен\w*|тариф\w*)\b", re.I)),
]

TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")


def local(tag: str) -> str:
    """'{ns}title' -> 'title'."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def child(el: ET.Element, *names: str) -> ET.Element | None:
    for c in el:
        if local(c.tag) in names:
            return c
    return None


def text_of(el: ET.Element | None) -> str:
    if el is None:
        return ""
    return "".join(el.itertext()).strip()


def clean(s: str, limit: int | None = None) -> str:
    s = html.unescape(TAG_RE.sub(" ", s or ""))
    s = WS_RE.sub(" ", s).strip()
    if limit and len(s) > limit:
        s = s[:limit].rsplit(" ", 1)[0].rstrip(",.;:") + "…"
    return s


def parse_date(s: str) -> datetime | None:
    s = (s or "").strip()
    if not s:
        return None
    try:
        d = parsedate_to_datetime(s)
    except (TypeError, ValueError, IndexError):
        try:
            d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc)


def atom_link(entry: ET.Element) -> str:
    links = [c for c in entry if local(c.tag) == "link"]
    for ln in links:
        if ln.get("rel", "alternate") == "alternate" and ln.get("href"):
            return ln.get("href", "")
    return links[0].get("href", "") if links else ""


def parse_feed(raw: bytes) -> list[dict]:
    root = ET.fromstring(raw)
    out = []
    if local(root.tag) == "feed":  # Atom
        for e in root:
            if local(e.tag) != "entry":
                continue
            out.append({
                "title": text_of(child(e, "title")),
                "link": atom_link(e),
                "date": text_of(child(e, "published", "updated")),
                "summary": text_of(child(e, "summary")) or text_of(child(e, "content")),
            })
    else:  # RSS 2.0 / RSS 1.0 (RDF)
        items = [i for i in root.iter() if local(i.tag) == "item"]
        for i in items:
            out.append({
                "title": text_of(child(i, "title")),
                "link": text_of(child(i, "link")) or text_of(child(i, "guid")),
                "date": text_of(child(i, "pubDate", "date", "published", "updated")),
                "summary": text_of(child(i, "description", "summary", "encoded")),
            })
    return out


def tags_for(title: str, summary: str, category: str) -> list[str]:
    hay = f"{title} {summary}"
    tags = [name for name, rx in TAG_RULES if rx.search(hay)]
    if category == "science":
        tags = [t for t in tags if t not in ("релиз",)]
        tags.insert(0, "исследование")
    return tags


# ---- Дедупликация: одна новость из разных источников -> общий "group" ----
DEDUP_WINDOW = timedelta(days=3)   # сравниваем только записи, опубликованные близко по времени
DEDUP_JACCARD = 0.3                # доля общих значимых слов (0.2 уже даёт ложные склейки)
DEDUP_MIN_SHARED = 3               # и минимум столько общих слов
STOPWORDS = set("""
a an the and or but of to in on at for from by with without as is are was were be been being it its this that these
those how why what when where who which new now just about into over after before vs via up out more most than your
you we our they their his her not no can will would could should may might has have had do does did says say said
get gets got here there all any one two first latest week day today report reports
и в во на не что как к с со по из за от до для о об а но или же ли бы то это этот эта эти его ее их мы вы они он она
новый новая новые как почему теперь уже ещё еще так при под над без про через чем который которая которые
""".split())
WORD_RE = re.compile(r"[\w.+-]+", re.U)


def title_tokens(title: str) -> frozenset[str]:
    out = set()
    for w in WORD_RE.findall(title.lower()):
        w = w.strip(".+-_")
        if len(w) < 2 or w in STOPWORDS:
            continue
        # Грубый стемминг: «launches»/«launched», «модели»/«моделью» -> общий префикс.
        out.add(w[:6] if w.isalpha() else w)
    return frozenset(out)


def link_key(link: str) -> str:
    return re.sub(r"^https?://(www\.)?", "", link.split("?")[0].split("#")[0]).rstrip("/").lower()


def assign_groups(items: list[dict]) -> int:
    """Проставляет it["group"] у записей, которые пересказывают одну новость. Возвращает число склеек.

    Правила: разные источники; дата в пределах DEDUP_WINDOW; совпадает ссылка
    или заголовки похожи (Jaccard >= DEDUP_JACCARD и >= DEDUP_MIN_SHARED общих слов).
    """
    n = len(items)
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    toks = [title_tokens(it["title"]) for it in items]
    dates = [datetime.fromisoformat(it["published"]) for it in items]
    index: dict[str, list[int]] = {}
    by_link: dict[str, int] = {}
    merges = 0
    for i, it in enumerate(items):
        cands: dict[int, int] = {}
        for t in toks[i]:
            for j in index.get(t, ()):
                cands[j] = cands.get(j, 0) + 1
        lk = link_key(it["link"])
        if lk in by_link:
            cands[by_link[lk]] = 10**6  # та же ссылка = точно дубль
        for j, shared in cands.items():
            if items[j]["source"] == it["source"] or abs(dates[i] - dates[j]) > DEDUP_WINDOW:
                continue
            if shared < 10**6:
                union = len(toks[i]) + len(toks[j]) - shared
                if shared < DEDUP_MIN_SHARED or shared / union < DEDUP_JACCARD:
                    continue
            ri, rj = find(i), find(j)
            if ri != rj:
                parent[max(ri, rj)] = min(ri, rj)
                merges += 1
        for t in toks[i]:
            index.setdefault(t, []).append(i)
        by_link.setdefault(lk, i)

    for it in items:
        it.pop("group", None)
    roots: dict[int, list[int]] = {}
    for i in range(n):
        roots.setdefault(find(i), []).append(i)
    for members in roots.values():
        if len(members) > 1:
            gid = items[members[0]]["id"]
            for m in members:
                items[m]["group"] = gid
    return merges


def fetch_source(src: dict) -> tuple[dict, list[dict]]:
    status = {"id": src["id"], "name": src["name"], "category": src["category"], "ok": False, "count": 0, "error": None,
              "weight": src.get("weight", 1), "family": src.get("family", src["id"])}
    req = urllib.request.Request(src["url"], headers={"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*"})
    entries = None
    for attempt in (1, 2):  # один повтор: сетевые сбои (обрыв, таймаут) обычно разовые
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                raw = resp.read()
            entries = parse_feed(raw)
            break
        except Exception as exc:  # noqa: BLE001 — один упавший источник не должен ронять сборку
            status["error"] = f"{type(exc).__name__}: {exc}"[:200]
            if attempt == 1:
                time.sleep(5)
    if entries is None:
        return status, []
    status["error"] = None

    is_release_feed = src["url"].endswith("/releases.atom")
    product = re.sub(r"\s*\(.*?\)\s*$", "", src["name"])

    items = []
    for e in entries[: src.get("max_items", DEFAULT_MAX_ITEMS)]:
        link = e["link"].strip()
        title = clean(e["title"])
        if not link or not title:
            continue
        if is_release_feed and product.lower() not in title.lower():
            title = f"{product} {title}"  # «1.148.0» -> «VS Code 1.148.0»
        summary = clean(e["summary"], SUMMARY_LEN)
        d = parse_date(e["date"])
        items.append({
            "id": hashlib.sha1(link.encode()).hexdigest()[:12],
            "title": title,
            "link": link,
            "summary": summary if summary != title else "",
            "source": src["id"],
            "category": src["category"],
            "published": d.isoformat(timespec="seconds") if d else None,
            "tags": tags_for(title, summary, src["category"]),
        })
        if is_release_feed and "релиз" not in items[-1]["tags"]:
            items[-1]["tags"].insert(0, "релиз")
    status["ok"] = True
    status["count"] = len(items)
    return status, items


# ---- Фильтр по теме: "require": "ai" в sources.json оставляет только записи про ИИ ----
# (лента «ИИ» Хабра приносит и посторонние статьи — про GTA, финтех, конференции)
TOPIC_FILTERS = {
    "ai": re.compile(
        r"(?<!\w)(ии|ai|нейросет\w*|нейронк\w*|llm\w*|gpt\w*|chatgpt|claude|gemini|gemma|gigachat|yandexgpt|alice ai|"
        r"deepseek|qwen|llama|mistral|grok|copilot|cursor|codex|openai|anthropic|модел\w*|агент\w*|"
        r"машинн\w* обучен\w*|ml|deep learning|промпт\w*|prompt\w*|rag|эмбеддинг\w*|трансформер\w*|"
        r"инференс\w*|токен\w*|вайб\w*|генеративн\w*|чат-?бот\w*|ollama|mcp|fine-?tun\w*|дообучен\w*)(?!\w)", re.I),
}


# ---- Чистка описаний: служебный текст фидов мешает читать ----
HN_META_RE = re.compile(r"(?:Article URL:\s*\S+\s*)?Comments URL:\s*(?P<url>\S+)\s*Points:\s*(?P<points>\d+)\s*#\s*Comments:\s*(?P<comments>\d+)", re.I)
SUMMARY_JUNK = [
    re.compile(r"^arXiv:\S+\s+Announce Type:\s*\S+\s+Abstract:\s*", re.I),   # arXiv
    re.compile(r"\s*Читать далее\s*…?$"),                                     # Хабр
    re.compile(r"^What's changed\s*", re.I),                                   # релизы GitHub
]


def tidy(it: dict) -> None:
    """Приводит описание в порядок. Идемпотентна — применяется и к уже сохранённым записям."""
    s = it.get("summary") or ""
    if it["source"] == "hn":
        m = HN_META_RE.search(s)
        if m:
            it["points"] = int(m["points"])
            it["comments"] = int(m["comments"])
            it["discussion"] = m["url"]
            s = s[: m.start()]
        s = re.sub(r"^Article URL:\s*\S+\s*", "", s)
    for rx in SUMMARY_JUNK:
        s = rx.sub("", s)
    s = s.strip()
    if re.fullmatch(r"https?://\S+", s) or s == it["title"]:
        s = ""  # описание из одной ссылки или повтор заголовка ничего не добавляет
    it["summary"] = s


def main() -> int:
    sources = json.loads(SOURCES_FILE.read_text(encoding="utf-8"))["sources"]
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat(timespec="seconds")

    existing: dict[str, dict] = {}
    if OUT_FILE.exists():
        try:
            for it in json.loads(OUT_FILE.read_text(encoding="utf-8")).get("items", []):
                existing[it["id"]] = it
        except (json.JSONDecodeError, KeyError):
            pass

    with ThreadPoolExecutor(max_workers=10) as pool:
        results = list(pool.map(fetch_source, sources))

    statuses = []
    new_count = 0
    for status, items in results:
        statuses.append(status)
        for it in items:
            old = existing.get(it["id"])
            it["first_seen"] = old["first_seen"] if old else now_iso
            if not it["published"]:
                it["published"] = it["first_seen"]
            if not old:
                new_count += 1
            existing[it["id"]] = it

    # Срок хранения — по источнику (keep_days в sources.json): статьи arXiv, например, не нужны 45 дней.
    keep = {s["id"]: s.get("keep_days", KEEP_DAYS) for s in sources}
    by_id = {s["id"]: s for s in sources}
    items = []
    for it in existing.values():
        src = by_id.get(it["source"])
        if not src or datetime.fromisoformat(it["published"]) < now - timedelta(days=keep[it["source"]]):
            continue
        tidy(it)
        it["category"] = src["category"]  # категорию берём из sources.json: её можно поменять задним числом
        rx = TOPIC_FILTERS.get(src.get("require", ""))
        if rx and not rx.search(f"{it['title']} {it['summary']}"):
            continue
        items.append(it)
    # Не показываем «записи из будущего» (кривые даты в фидах) выше реальных.
    for it in items:
        if datetime.fromisoformat(it["published"]) > now + timedelta(hours=1):
            it["published"] = it["first_seen"]
    items.sort(key=lambda it: it["published"], reverse=True)
    items = items[:MAX_TOTAL]
    merges = assign_groups(items)

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {"generated_at": now_iso, "sources": statuses, "items": items}
    OUT_FILE.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    failed = [s for s in statuses if not s["ok"]]
    print(f"Источников: {len(statuses)}, ошибок: {len(failed)}, новых записей: {new_count}, всего: {len(items)}, склеено дублей: {merges}")
    for s in statuses:
        mark = "OK " if s["ok"] else "ERR"
        print(f"  [{mark}] {s['name']:<32} {s['count']:>3}  {s['error'] or ''}")
    # Ошибки отдельных источников не валят сборку; падаем, только если не ответил никто.
    return 1 if len(failed) == len(statuses) else 0


if __name__ == "__main__":
    sys.exit(main())
