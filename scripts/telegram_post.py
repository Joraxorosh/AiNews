"""Рассылает в Telegram главное из свежего сбора и новые обзоры недели — всем, кто подписался на бота.

Как работает (сервера нет, всё в GitHub Actions после fetch_news.py):
  1. Забираем новые сообщения боту (getUpdates): /start — подписка, /stop — отписка.
  2. Подписчикам отправляем новые обзоры недели и главное из ленты.
  3. Состояние — в state/telegram.json. Репозиторий публичный, поэтому список подписчиков
     (их Telegram ID) хранится зашифрованным: ключ выводится из токена бота (секрет).
     Если токен сменить, список не расшифруется — подписчикам нужно будет снова нажать /start.

Секреты: TELEGRAM_BOT_TOKEN (обязательно), TELEGRAM_CHAT_ID (необязательно — доп. получатель,
например канал). Без токена скрипт ничего не делает. Только стандартная библиотека.
Проверка без отправки: python scripts/telegram_post.py --dry-run
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import html
import json
import os
import sys
import urllib.error
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
KEEP_IDS = 3000        # сколько отправленных сюжетов помнить
TAG_SCORE = {"релиз": 2, "безопасность": 2, "модель": 1, "баг/сбой": 1, "open source": 1, "агенты": 1}
CAT_NAME = {"models": "Модели ИИ", "tools": "Инструменты", "science": "Наука", "it": "IT и безопасность"}

WELCOME = ("Подписка на AI News оформлена.\n\n"
           "Буду присылать главное из ленты (несколько раз в день) и обзор недели на русском.\n"
           f"Сайт: {SITE_URL}\nПоследний обзор: {SITE_URL}#review\n\n"
           "Отписаться — /stop")
BYE = "Вы отписались от AI News. Вернуться — /start"


# ---------- шифрование списка подписчиков (HMAC-SHA256 в режиме счётчика + MAC) ----------
def _key(token: str) -> bytes:
    return hashlib.sha256(b"ainews-telegram-state:" + token.encode()).digest()


def _stream(key: bytes, nonce: bytes, n: int) -> bytes:
    out = b""
    i = 0
    while len(out) < n:
        out += hmac.new(key, nonce + i.to_bytes(8, "big"), hashlib.sha256).digest()
        i += 1
    return out[:n]


def seal(data: list[int], token: str) -> str:
    key = _key(token)
    raw = json.dumps(sorted(data)).encode()
    nonce = os.urandom(16)
    ct = bytes(a ^ b for a, b in zip(raw, _stream(key, nonce, len(raw))))
    tag = hmac.new(key, nonce + ct, hashlib.sha256).digest()[:16]
    return base64.b64encode(nonce + tag + ct).decode()


def unseal(blob: str, token: str) -> list[int] | None:
    if not blob:
        return []
    key = _key(token)
    b = base64.b64decode(blob)
    nonce, tag, ct = b[:16], b[16:32], b[32:]
    if not hmac.compare_digest(tag, hmac.new(key, nonce + ct, hashlib.sha256).digest()[:16]):
        return None  # другой токен — расшифровать нельзя
    return json.loads(bytes(a ^ b for a, b in zip(ct, _stream(key, nonce, len(ct)))))


# ---------- Telegram API ----------
class Blocked(Exception):
    """Пользователь заблокировал бота или удалил чат — убираем из подписчиков."""


def api(token: str, method: str, **params) -> dict:
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}", data=data)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = json.loads(e.read() or b"{}")
        if e.code == 403 or "chat not found" in str(body.get("description", "")):
            raise Blocked(body.get("description")) from e
        raise RuntimeError(f"{method}: {e.code} {body.get('description', '')}") from e
    if not body.get("ok"):
        raise RuntimeError(f"{method}: {body.get('description', 'error')}")
    return body["result"]


def send(token: str, chat, text: str, dry: bool) -> None:
    if dry:
        print(f"----- -> {chat} -----\n{text}")
        return
    api(token, "sendMessage", chat_id=chat, text=text, parse_mode="HTML", disable_web_page_preview="true")


# ---------- содержимое ----------
def score(items: list[dict], src: dict) -> tuple[int, int]:
    families = {src.get(i["source"], {}).get("family", i["source"]) for i in items}
    weight = max(src.get(i["source"], {}).get("weight", 1) for i in items)
    tags = {t for i in items for t in i.get("tags", [])}
    points = max([i.get("points", 0) for i in items] + [0])
    s = 3 * (len(families) - 1) + 2 * (weight - 1) + sum(TAG_SCORE.get(t, 0) for t in tags)
    s += 3 if points >= 800 else 2 if points >= 300 else 0
    return s, len(families)


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
    fresh_after = (datetime.now(timezone.utc) - timedelta(hours=FRESH_HOURS)).isoformat()
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
            picked.append((s, n_src, key, main))
    if not picked:
        return None, []
    picked.sort(key=lambda x: (-x[0], x[3]["published"]))
    picked = picked[:MAX_PER_POST]
    lines = ["<b>Главное в ленте</b>"]
    for _, n_src, _, main in picked:
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


# ---------- основной цикл ----------
def main() -> int:
    dry = "--dry-run" in sys.argv
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    extra_chat = os.environ.get("TELEGRAM_CHAT_ID", "")
    if not token:
        print("Telegram: секрет TELEGRAM_BOT_TOKEN не задан — пропускаю.")
        return 0

    src = {s["id"]: s for s in json.loads(SOURCES.read_text(encoding="utf-8"))["sources"]}
    news = json.loads(NEWS.read_text(encoding="utf-8"))
    weekly = json.loads(WEEKLY.read_text(encoding="utf-8")) if WEEKLY.exists() else {"issues": []}

    first_run = not STATE.exists()
    state = json.loads(STATE.read_text(encoding="utf-8")) if not first_run else {}
    state.setdefault("posted", [])
    state.setdefault("reviews", [])
    state.setdefault("offset", 0)
    subs = unseal(state.get("subscribers", ""), token)
    if subs is None:
        print("Telegram: список подписчиков зашифрован другим токеном — начинаю заново.")
        subs = []
    subs = set(subs)
    if first_run:
        # Не заваливаем первых подписчиков историей: всё текущее считаем уже отправленным.
        state["posted"] = sorted({i.get("group", i["id"]) for i in news["items"]})
        state["reviews"] = [i["id"] for i in weekly["issues"]]

    sent = 0
    try:
        # 1. Подписки и отписки.
        updates = [] if dry else api(token, "getUpdates", offset=state["offset"], timeout=0,
                                     allowed_updates=json.dumps(["message"]))
        for u in updates:
            state["offset"] = u["update_id"] + 1
            msg = u.get("message") or {}
            chat = (msg.get("chat") or {}).get("id")
            text = (msg.get("text") or "").strip().lower()
            if not chat or (msg.get("chat") or {}).get("type") != "private":
                continue
            try:
                if text.startswith("/stop"):
                    subs.discard(chat)
                    send(token, chat, BYE, dry)
                elif text.startswith("/start") or chat not in subs:
                    new = chat not in subs
                    subs.add(chat)
                    if new or text.startswith("/start"):
                        send(token, chat, WELCOME, dry)
            except Blocked:
                subs.discard(chat)

        recipients = sorted(subs) + ([extra_chat] if extra_chat else [])
        if dry:
            recipients = ["<dry-run>"]

        # 2. Новые обзоры недели.
        for issue in reversed(weekly["issues"]):
            if issue["id"] in state["reviews"]:
                continue
            for chat in recipients:
                try:
                    for part in review_messages(issue):
                        send(token, chat, part, dry)
                except Blocked:
                    subs.discard(chat)
            state["reviews"].append(issue["id"])

        # 3. Главное из ленты.
        msg, keys = news_message(news, src, set(state["posted"]))
        if msg and recipients:
            for chat in recipients:
                try:
                    send(token, chat, msg, dry)
                    sent += 1
                except Blocked:
                    subs.discard(chat)
        if keys:
            state["posted"] = (state["posted"] + keys)[-KEEP_IDS:]
        print(f"Telegram: подписчиков {len(subs)}, сюжетов в рассылке {len(keys)}, отправлено сообщений {sent}")
    except Exception as exc:  # noqa: BLE001 — сбой Telegram не должен ронять сборку сайта
        print(f"Telegram: ошибка — {type(exc).__name__}: {exc}")
    finally:
        if not dry:
            state["subscribers"] = seal(list(subs), token)
            STATE.parent.mkdir(exist_ok=True)
            STATE.write_text(json.dumps(state, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
