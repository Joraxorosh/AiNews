"""Собирает новости из RSS/Atom-источников (sources.json) в site/data/news.json.

Только стандартная библиотека Python 3.11+. Новые записи сливаются с уже
сохранёнными, так что история накапливается между запусками.

Запуск:  python scripts/fetch_news.py
"""
from __future__ import annotations

import gzip
import hashlib
import html
import json
import math
import re
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit

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

SCRIPT_STYLE_RE = re.compile(r"<(script|style)\b[^>]*>.*?</\1>", re.I | re.S)
TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")
ARXIV_ID_RE = re.compile(r"arxiv\.org/(?:abs|pdf)/(\d+\.\d+)", re.I)
TRACKING_PARAMS = frozenset({
    "ref", "fbclid", "gclid", "yclid", "mc_cid", "mc_eid", "igshid", "si", "feature",
})


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
    s = SCRIPT_STYLE_RE.sub(" ", s or "")
    s = html.unescape(TAG_RE.sub(" ", s))
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
DEDUP_JACCARD = 0.32               # порог IDF-взвешенного Jaccard по значимым словам
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
    """Нормализует URL для дедупликации: убирает трекинговые параметры, но сохраняет значимые (?p=, ?id=, ?v=)."""
    p = urlsplit(link.strip())
    host = re.sub(r"^www\.", "", p.netloc.lower())
    path = p.path.rstrip("/")
    params = sorted(
        (k, v) for k, v in parse_qsl(p.query, keep_blank_values=False)
        if not k.lower().startswith("utm_") and k.lower() not in TRACKING_PARAMS
    )
    query = ("?" + urlencode(params)) if params else ""
    return f"{host}{path}{query}".lower()


def assign_groups(items: list[dict], parsed_dates: list[datetime] | None = None) -> int:
    """Проставляет it["group"] у записей, которые пересказывают одну новость. Возвращает число склеек.

    Правила: разные источники (включая защиту от транзитивной склейки одного источника);
    диапазон дат всей группы в пределах DEDUP_WINDOW; совпадает ссылка
    или заголовки похожи (IDF-взвешенный Jaccard >= DEDUP_JACCARD и >= DEDUP_MIN_SHARED общих слов).
    """
    n = len(items)
    toks = [title_tokens(it["title"]) for it in items]
    dates = parsed_dates if parsed_dates is not None else [datetime.fromisoformat(it["published"]) for it in items]
    lks = [link_key(it["link"]) for it in items]
    arxiv_ids = [m.group(1) if (m := ARXIV_ID_RE.search(it["link"])) else None for it in items]

    # IDF снижает вес частых шаблонных слов («large language models», «hackers exploit critical flaw»).
    df: dict[str, int] = {}
    for ts in toks:
        for t in ts:
            df[t] = df.get(t, 0) + 1
    idf = {t: math.log((n + 1) / (c + 1)) + 1.0 for t, c in df.items()}
    tok_w = [sum(idf[t] for t in ts) for ts in toks]

    index: dict[str, list[int]] = {}
    by_link: dict[str, list[int]] = {}
    edges: list[tuple[int, float, int, int]] = []

    for i, it in enumerate(items):
        lk = lks[i]
        seen_j: set[int] = set()
        for j in by_link.get(lk, ()):
            if items[j]["source"] != it["source"] and abs(dates[i] - dates[j]) <= DEDUP_WINDOW:
                edges.append((1, 1.0, i, j))
                seen_j.add(j)

        cands: dict[int, int] = {}
        for t in toks[i]:
            for j in index.get(t, ()):
                if j not in seen_j:
                    cands[j] = cands.get(j, 0) + 1
        for j, shared_cnt in cands.items():
            if items[j]["source"] == it["source"] or abs(dates[i] - dates[j]) > DEDUP_WINDOW:
                continue
            if arxiv_ids[i] and arxiv_ids[j] and arxiv_ids[i] != arxiv_ids[j]:
                continue
            if shared_cnt < DEDUP_MIN_SHARED:
                continue
            shared_w = sum(idf[t] for t in toks[i] & toks[j])
            union_w = tok_w[i] + tok_w[j] - shared_w
            sim = shared_w / union_w if union_w > 0 else 0.0
            if sim >= DEDUP_JACCARD:
                edges.append((0, sim, i, j))

        for t in toks[i]:
            index.setdefault(t, []).append(i)
        by_link.setdefault(lk, []).append(i)

    # Сначала объединяем точные совпадения ссылок и наиболее близкие заголовки.
    edges.sort(key=lambda e: (e[0], e[1]), reverse=True)

    parent = list(range(n))
    comp_sources = [{it["source"]} for it in items]
    comp_min_d = list(dates)
    comp_max_d = list(dates)

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    merges = 0
    for _is_link, _sim, i, j in edges:
        ri, rj = find(i), find(j)
        if ri == rj:
            continue
        if comp_sources[ri] & comp_sources[rj]:
            continue
        lo = min(comp_min_d[ri], comp_min_d[rj])
        hi = max(comp_max_d[ri], comp_max_d[rj])
        if hi - lo > DEDUP_WINDOW:
            continue
        root, child_root = (ri, rj) if ri < rj else (rj, ri)
        parent[child_root] = root
        comp_sources[root] |= comp_sources[child_root]
        comp_min_d[root] = lo
        comp_max_d[root] = hi
        merges += 1

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


def _read_url(url: str) -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
            "Accept-Encoding": "gzip, deflate",
        },
    )
    last_exc: Exception | None = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                raw = resp.read()
                enc = (resp.headers.get("Content-Encoding") or "").lower()
                if "gzip" in enc:
                    raw = gzip.decompress(raw)
                elif "deflate" in enc:
                    try:
                        raw = zlib.decompress(raw)
                    except zlib.error:
                        raw = zlib.decompress(raw, -zlib.MAX_WBITS)
                return raw
        except urllib.error.HTTPError as exc:
            last_exc = exc
            if exc.code < 500 or attempt == 1:
                raise
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_exc = exc
            if attempt == 1:
                raise
        time.sleep(1.5)
    assert last_exc is not None
    raise last_exc


def fetch_source(src: dict) -> tuple[dict, list[dict]]:
    status = {"id": src["id"], "name": src["name"], "category": src["category"], "ok": False, "count": 0, "error": None,
              "weight": src.get("weight", 1), "family": src.get("family", src["id"])}
    try:
        raw = _read_url(src["url"])
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
    future_limit = now + timedelta(hours=1)
    dated_items: list[tuple[datetime, dict]] = []
    for it in existing.values():
        if it.get("source") not in valid_ids:
            continue
        pub = parse_date(it.get("published", "")) or parse_date(it.get("first_seen", ""))
        if not pub:
            continue
        # Не показываем «записи из будущего» (кривые даты в фидах) выше реальных.
        if pub > future_limit:
            fs = parse_date(it.get("first_seen", "")) or now
            it["published"] = fs.isoformat(timespec="seconds")
            pub = fs
        if pub >= cutoff:
            dated_items.append((pub, it))

    dated_items.sort(key=lambda pair: pair[0], reverse=True)
    dated_items = dated_items[:MAX_TOTAL]
    items = [it for _, it in dated_items]
    merges = assign_groups(items, [pub for pub, _ in dated_items])

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
