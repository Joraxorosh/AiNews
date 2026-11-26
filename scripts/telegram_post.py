"""Публикует в Telegram главное из свежего сбора и новые обзоры недели.

Запускается в GitHub Actions после fetch_news.py. Токен и чат — только из секретов
(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID); без них скрипт молча ничего не делает.
Что уже отправлено, хранится в state/telegram.json (коммитится вместе с новостями).

Только стандартная библиотека. Локальный «сухой» прогон без отправки:
    python scripts/telegram_post.py --dry-run
"""
from __future__ import annotations

import html
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NEWS = ROOT / "site" / "data" / "news.json"
WEEKLY = ROOT / "site" / "data" / "weekly.json"
SOURCES = ROOT / "sources.json"
STATE = ROOT / "state" / "telegram.json"
SITE_URL = os.environ.get("SITE_URL", "https://joraxorosh.github.io/AiNews/")

FRESH_HOURS = 24       # рассматриваем сюжеты, впервые замеченные за последние сутки
MIN_SCORE = 5          # порог важности (та же формула, что в дайджесте на сайте)
MAX_PER_POST = 6       # не больше N сюжетов в одном сообщении
KEEP_IDS = 3000        # сколько отправленных id помнить
TAG_SCORE = {"релиз": 2, "безопасность": 2, "модель": 1, "баг/сбой": 1, "open source": 1, "агенты": 1}
CAT_NAME = {"models": "Модели ИИ", "tools": "Инструменты", "science": "Наука", "it": "IT и безопасность"}


def score(items: list[dict], src: dict) -> tuple[int, int]:
    families = {src.get(i["source"], {}).get("family", i["source"]) for i in items}
    weight = max(src.get(i["source"], {}).get("weight", 1) for i in items)
    tags = {t for i in items for t in i.get("tags", [])}
    points = max([i.get("points", 0) for i in items] + [0])
    s = 3 * (len(families) - 1) + 2 * (weight - 1) + sum(TAG_SCORE.get(t, 0) for t in tags)
    s += 3 if points >= 800 else 2 if points >= 300 else 0
    return s, len(families)


def send(token: str, chat: str, text: str, dry: bool) -> None:
    if dry:
        print("----- СООБЩЕНИЕ -----\n" + text)
        return
    data = urllib.parse.urlencode({
        "chat_id": chat, "text": text, "parse_mode": "HTML", "disable_web_page_preview": "true",
    }).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=data)
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.loads(resp.read())
    if not body.get("ok"):
        raise RuntimeError(body.get("description", "Telegram API error"))


def chunks(text: str, limit: int = 3900) -> list[str]:
    """Режет длинный текст по абзацам: у Telegram лимит 4096 символов на сообщение."""
    out, cur = [], ""
    for part in text.split("\n\n"):
        if cur and len(cur) + len(part) + 2 > limit:
            out.append(cur)
            cur = ""
        cur = f"{cur}\n\n{part}" if cur else part
    if cur:
        out.append(cur)
    return out


def news_message(news: dict, src: dict, posted: set[str]) -> tuple[str | None, list[str]]:
    now = datetime.now(timezone.utc)
    fresh_after = (now - timedelta(hours=FRESH_HOURS)).isoformat()
    groups: dict[str, list[dict]] = {}
    for it in news["items"]:
        groups.setdefault(it.get("group", it["id"]), []).append(it)
    picked = []
    for key, items in groups.items():
        if key in posted or any(i["source"].startswith("arxiv") for i in items):
            continue
        if min(i["first_seen"] for i in items) < fresh_after:
            continue
        s, n_src = score(items, src)
        if s >= MIN_SCORE:
            main = max(items, key=lambda i: src.get(i["source"], {}).get("weight", 1))
            picked.append((s, n_src, key, main, items))
    if not picked:
        return None, []
    picked.sort(key=lambda x: (-x[0], x[3]["published"]))
    picked = picked[:MAX_PER_POST]
    lines = ["<b>Главное в ленте</b>"]
    for _, n_src, _, main, items in picked:
        name = src.get(main["source"], {}).get("name", main["source"])
        extra = f" · {n_src} источника" if 2 <= n_src <= 4 else f" · {n_src} источников" if n_src > 4 else ""
        lines.append(
            f"• <a href=\"{html.escape(main['link'])}\">{html.escape(main['title'])}</a>\n"
            f"  <i>{html.escape(name)} · {CAT_NAME.get(main['category'], '')}{extra}</i>")
    lines.append(f"<a href=\"{SITE_URL}\">Вся лента</a> · <a href=\"{SITE_URL}#digest\">Дайджест</a>")
    return "\n\n".join(lines), [p[2] for p in picked]


def review_messages(issue: dict) -> list[str]:
    parts = [f"<b>{html.escape(issue['title'])}</b>", html.escape(issue["intro"])]
    for sec in issue["sections"]:
        pts = []
        for pt in sec["points"]:
            link = pt["links"][0] if pt.get("links") else None
            more = f" <a href=\"{html.escape(link['url'])}\">{html.escape(link['title'])}</a>" if link else ""
            pts.append(f"• {html.escape(pt['text'])}{more}")
        parts.append(f"<b>{html.escape(sec['title'])}</b>\n" + "\n".join(pts))
    parts.append(f"<a href=\"{SITE_URL}#review\">Обзор на сайте</a>")
    return chunks("\n\n".join(parts))


def main() -> int:
    dry = "--dry-run" in sys.argv
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat = os.environ.get("TELEGRAM_CHAT_ID", "")
    if not dry and not (token and chat):
        print("Telegram: секреты не заданы — пропускаю.")
        return 0

    src = {s["id"]: s for s in json.loads(SOURCES.read_text(encoding="utf-8"))["sources"]}
    news = json.loads(NEWS.read_text(encoding="utf-8"))
    weekly = json.loads(WEEKLY.read_text(encoding="utf-8")) if WEEKLY.exists() else {"issues": []}

    first_run = not STATE.exists()
    state = {"posted": [], "reviews": []} if first_run else json.loads(STATE.read_text(encoding="utf-8"))
    posted = set(state["posted"])

    try:
        if first_run:
            # Первый запуск: не заваливаем чат всей историей — отмечаем текущее как отправленное.
            state["posted"] = sorted({i.get("group", i["id"]) for i in news["items"]})
            state["reviews"] = [i["id"] for i in weekly["issues"][1:]]  # последний обзор отправим
            send(token, chat, "Бот AI News подключён. Буду присылать главное из ленты и обзоры недели.\n"
                              f"<a href=\"{SITE_URL}\">{SITE_URL}</a>", dry)
            posted = set(state["posted"])

        for issue in reversed(weekly["issues"]):
            if issue["id"] not in state["reviews"]:
                for msg in review_messages(issue):
                    send(token, chat, msg, dry)
                state["reviews"].append(issue["id"])

        msg, keys = news_message(news, src, posted)
        if msg:
            send(token, chat, msg, dry)
            state["posted"] = (state["posted"] + keys)[-KEEP_IDS:]
        print(f"Telegram: отправлено сюжетов {len(keys)}")
    except Exception as exc:  # noqa: BLE001 — сбой Telegram не должен ронять сборку сайта
        print(f"Telegram: ошибка — {type(exc).__name__}: {exc}")
        return 0
    finally:
        if not dry:
            STATE.parent.mkdir(exist_ok=True)
            STATE.write_text(json.dumps(state, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
