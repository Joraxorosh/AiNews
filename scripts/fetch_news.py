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


def fetch_source(src: dict) -> tuple[dict, list[dict]]:
    status = {"id": src["id"], "name": src["name"], "category": src["category"], "ok": False, "count": 0, "error": None}
    try:
        req = urllib.request.Request(src["url"], headers={"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read()
        entries = parse_feed(raw)
    except Exception as exc:  # noqa: BLE001 — один упавший источник не должен ронять сборку
        status["error"] = f"{type(exc).__name__}: {exc}"[:200]
        return status, []

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

    valid_ids = {s["id"] for s in sources}
    cutoff = now - timedelta(days=KEEP_DAYS)
    items = [
        it for it in existing.values()
        if it["source"] in valid_ids and datetime.fromisoformat(it["published"]) >= cutoff
    ]
    # Не показываем «записи из будущего» (кривые даты в фидах) выше реальных.
    for it in items:
        if datetime.fromisoformat(it["published"]) > now + timedelta(hours=1):
            it["published"] = it["first_seen"]
    items.sort(key=lambda it: it["published"], reverse=True)
    items = items[:MAX_TOTAL]

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {"generated_at": now_iso, "sources": statuses, "items": items}
    OUT_FILE.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    failed = [s for s in statuses if not s["ok"]]
    print(f"Источников: {len(statuses)}, ошибок: {len(failed)}, новых записей: {new_count}, всего: {len(items)}")
    for s in statuses:
        mark = "OK " if s["ok"] else "ERR"
        print(f"  [{mark}] {s['name']:<32} {s['count']:>3}  {s['error'] or ''}")
    # Ошибки отдельных источников не валят сборку; падаем, только если не ответил никто.
    return 1 if len(failed) == len(statuses) else 0


if __name__ == "__main__":
    sys.exit(main())
