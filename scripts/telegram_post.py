"""Рассылает в Telegram главное из свежего сбора и новые обзоры недели — всем, кто подписался на бота.

Как работает (сервера нет, всё в GitHub Actions после fetch_news.py):
  1. Забираем новые сообщения боту (getUpdates): /start — подписка, /stop — отписка,
     /topics слова — свои темы, /daily и /often — раз в день или несколько раз в день, /settings — настройки.
  2. Подписчикам отправляем новые обзоры недели и главное из ленты (+ блок «По вашим темам»).
  3. Состояние — в state/telegram.json. Репозиторий публичный, поэтому подписчики и их настройки
     (Telegram ID, темы) хранятся зашифрованными: ключ выводится из токена бота (секрет).
     Если токен сменить, список не расшифруется — подписчикам нужно будет снова нажать /start.

Секреты: TELEGRAM_BOT_TOKEN (обязательно), TELEGRAM_CHAT_ID (необязательно — доп. получатель,
например канал). Без токена скрипт ничего не делает. Только стандартная библиотека.
Проверка без отправки: python scripts/telegram_post.py --dry-run [--topics "claude, уязвимость"] [--daily]
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

MAX_TOPICS = 15        # слов в /topics
MAX_TOPIC_ITEMS = 8    # сюжетов в блоке «По вашим темам»
KEEP_SEEN = 300        # сколько сюжетов по темам помнить для каждого подписчика
DAILY_TOP = 8          # сюжетов в ежедневной сводке
DAILY_HOUR_MSK = 8     # ежедневная сводка — с первой сборкой после 8:00 по Москве
MSK = timezone(timedelta(hours=3))

COMMANDS = [
    ("topics", "Мои темы: /topics claude, gigachat, уязвимость"),
    ("daily", "Одно сообщение в день, утром"),
    ("often", "Главное несколько раз в день (по умолчанию)"),
    ("settings", "Мои настройки"),
    ("stop", "Отписаться"),
]
HELP = ("<b>Команды</b>\n"
        "/topics слова через запятую — свои темы: новости с этими словами придут отдельным блоком, "
        "даже если не попали в главное. Например: <code>/topics Claude Code, GigaChat, уязвимость</code>\n"
        "/topics off — убрать темы\n"
        "/daily — одно сообщение в день (утром): главное за сутки и ваши темы\n"
        "/often — главное несколько раз в день (как сейчас по умолчанию)\n"
        "/settings — мои настройки · /stop — отписаться\n\n"
        "<i>Сервера у бота нет: команды выполняются при очередном обновлении ленты, раз в несколько часов.</i>")
WELCOME = ("Подписка на AI News оформлена.\n\n"
           "Буду присылать главное из ленты (несколько раз в день) и обзор недели на русском.\n"
           f"Сайт: {SITE_URL}\nПоследний обзор: {SITE_URL}#review\n\n" + HELP)
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


def seal(data, token: str) -> str:
    """Шифрует JSON (раньше — список ID подписчиков, теперь — словарь с их настройками)."""
    key = _key(token)
    raw = json.dumps(sorted(data) if isinstance(data, list) else data, ensure_ascii=False, sort_keys=True).encode()
    nonce = os.urandom(16)
    ct = bytes(a ^ b for a, b in zip(raw, _stream(key, nonce, len(raw))))
    tag = hmac.new(key, nonce + ct, hashlib.sha256).digest()[:16]
    return base64.b64encode(nonce + tag + ct).decode()


def unseal(blob: str, token: str):
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


def norm(s: str) -> str:
    return s.lower().replace("ё", "е")


def parse_topics(arg: str) -> list[str]:
    """«Claude Code, GigaChat;уязвимость» -> ['Claude Code', 'GigaChat', 'уязвимость'] (без повторов)."""
    out: list[str] = []
    for w in arg.replace(";", ",").split(","):
        w = " ".join(w.split()).strip(" .\"'«»")[:40]
        if len(w) >= 2 and norm(w) not in [norm(x) for x in out]:
            out.append(w)
    return out[:MAX_TOPICS]


class Story:
    """Сюжет = записи ленты с общим group (одна новость из разных источников)."""

    def __init__(self, key: str, items: list[dict], src: dict):
        self.key, self.items = key, items
        self.score, self.n_src = score(items, src)
        self.main = max(items, key=lambda i: src.get(i["source"], {}).get("weight", 1))
        self.first_seen = min(i["first_seen"] for i in items)
        self.published = max(i.get("published") or i["first_seen"] for i in items)
        self.arxiv = any(i["source"].startswith("arxiv") for i in items)
        self.text = norm(" ".join(f"{i['title']} {i.get('summary', '')}" for i in items))

    def topics(self, words: list[str]) -> list[str]:
        return [w for w in words if norm(w) in self.text]


def stories(news: dict, src: dict, hours: int = FRESH_HOURS) -> list[Story]:
    """Свежие сюжеты (впервые замечены за последние hours часов), без arXiv; важные — первыми.
    Дата публикации тоже должна быть недавней: у только что добавленного источника весь архив
    «впервые замечен» сейчас, но рассылать его как новости не нужно."""
    now = datetime.now(timezone.utc)
    since = (now - timedelta(hours=hours)).isoformat()
    published_since = (now - timedelta(hours=2 * hours)).isoformat()
    groups: dict[str, list[dict]] = {}
    for it in news["items"]:
        groups.setdefault(it.get("group", it["id"]), []).append(it)
    out = [Story(k, v, src) for k, v in groups.items()]
    out = [s for s in out if not s.arxiv and s.first_seen >= since and s.published >= published_since]
    out.sort(key=lambda s: (-s.score, s.main["published"]))
    return out


def story_line(s: Story, src: dict, matched: list[str] | None = None) -> str:
    name = src.get(s.main["source"], {}).get("name", s.main["source"])
    n = s.n_src
    extra = f" · {n} источника" if 2 <= n <= 4 else f" · {n} источников" if n > 4 else ""
    why = f" · {html.escape(', '.join(matched))}" if matched else ""
    return (f"• <a href=\"{html.escape(s.main['link'])}\">{html.escape(s.main['title'])}</a>\n"
            f"  <i>{html.escape(name)} · {CAT_NAME.get(s.main['category'], '')}{extra}{why}</i>")


def render(title: str, main: list[Story], topical: list[tuple[Story, list[str]]], src: dict) -> str:
    lines = [f"<b>{title}</b>"] if main else []
    lines += [story_line(s, src) for s in main]
    if topical:
        lines.append("<b>По вашим темам</b>")
        lines += [story_line(s, src, m) for s, m in topical]
    lines.append(f"<a href=\"{SITE_URL}\">Вся лента</a> · <a href=\"{SITE_URL}#digest\">Дайджест</a>")
    return "\n\n".join(lines)


def pick_topical(all_stories: list[Story], words: list[str], skip: set[str]) -> list[tuple[Story, list[str]]]:
    out = []
    for s in all_stories:
        if s.key in skip:
            continue
        m = s.topics(words)
        if m:
            out.append((s, m))
    return out[:MAX_TOPIC_ITEMS]


def news_message(news: dict, src: dict, posted: set[str]) -> tuple[str | None, list[str]]:
    """Общая рассылка: важные сюжеты, которые ещё не отправлялись."""
    picked = [s for s in stories(news, src) if s.key not in posted and s.score >= MIN_SCORE][:MAX_PER_POST]
    if not picked:
        return None, []
    return render("Главное в ленте", picked, [], src), [s.key for s in picked]


def personal_message(all_stories: list[Story], src: dict, main: list[Story], cfg: dict,
                     skip: set[str]) -> tuple[str | None, list[str]]:
    """Сообщение подписчику: общий блок main (может быть пустым) + сюжеты по его темам.
    Возвращает текст и ключи сюжетов по темам (их запоминаем, чтобы не повторять)."""
    words = cfg.get("topics") or []
    seen = set(cfg.get("seen") or [])
    topical = pick_topical(all_stories, words, skip | seen | {s.key for s in main}) if words else []
    if not main and not topical:
        return None, []
    title = "Главное за сутки" if cfg.get("mode") == "daily" else "Главное в ленте"
    return render(title, main, topical, src), [s.key for s, _ in topical]


def daily_due(cfg: dict, now: datetime) -> bool:
    local = now.astimezone(MSK)
    return local.hour >= DAILY_HOUR_MSK and cfg.get("last_daily") != local.date().isoformat()


def settings_text(cfg: dict) -> str:
    words = cfg.get("topics") or []
    mode = ("одно сообщение в день (утром) — /often, чтобы получать чаще" if cfg.get("mode") == "daily"
            else "главное несколько раз в день — /daily, чтобы раз в день")
    topics = (", ".join(html.escape(w) for w in words) + " — изменить: /topics слова, убрать: /topics off"
              if words else "не заданы — /topics слова через запятую")
    return f"<b>Ваши настройки</b>\nРежим: {mode}\nТемы: {topics}"


def handle_command(text: str, cfg: dict) -> str | None:
    """Команда подписчика -> ответ (cfg меняется на месте). None — не команда настроек."""
    cmd, _, arg = text.strip().partition(" ")
    cmd = cmd.split("@")[0].lower()
    if cmd == "/topics":
        arg = arg.strip()
        if arg.lower() in ("off", "нет", "-", "стоп"):
            cfg.pop("topics", None)
            cfg.pop("seen", None)
            return "Темы убраны. Задать снова: /topics слова через запятую"
        if not arg:
            return settings_text(cfg) + "\n\nПример: <code>/topics Claude Code, GigaChat, уязвимость</code>"
        words = parse_topics(arg)
        if not words:
            return "Не понял темы. Пример: <code>/topics Claude Code, GigaChat, уязвимость</code>"
        cfg["topics"] = words
        return ("Ваши темы: " + ", ".join(html.escape(w) for w in words) +
                ".\nНовости с этими словами буду присылать блоком «По вашим темам». Убрать — /topics off")
    if cmd == "/daily":
        cfg["mode"] = "daily"
        return (f"Теперь одно сообщение в день — утром (после {DAILY_HOUR_MSK}:00 по Москве): главное за сутки "
                "и новости по вашим темам. Обзор недели приходит как обычно. Чаще — /often")
    if cmd == "/often":
        cfg.pop("mode", None)
        cfg.pop("last_daily", None)
        return "Снова присылаю главное несколько раз в день. Раз в день — /daily"
    if cmd in ("/settings", "/help"):
        return settings_text(cfg) + "\n\n" + HELP
    return None


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


def load_subs(blob: str, token: str) -> dict[str, dict]:
    """Подписчики: {"<chat id>": {topics, mode, last_daily, seen}}. Старый формат — просто список ID."""
    data = unseal(blob, token)
    if data is None:
        print("Telegram: список подписчиков зашифрован другим токеном — начинаю заново.")
        return {}
    if isinstance(data, list):
        return {str(c): {} for c in data}
    return {str(k): v for k, v in data.items()}


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
    now = datetime.now(timezone.utc)

    first_run = not STATE.exists()
    state = json.loads(STATE.read_text(encoding="utf-8")) if not first_run else {}
    state.setdefault("posted", [])
    state.setdefault("reviews", [])
    state.setdefault("offset", 0)
    subs = load_subs(state.get("subscribers", ""), token)
    if first_run:
        # Не заваливаем первых подписчиков историей: всё текущее считаем уже отправленным.
        state["posted"] = sorted({i.get("group", i["id"]) for i in news["items"]})
        state["reviews"] = [i["id"] for i in weekly["issues"]]
    if dry:
        # Проверка без отправки: один условный подписчик с настройками из аргументов.
        cfg: dict = {}
        if "--topics" in sys.argv:
            cfg["topics"] = parse_topics(sys.argv[sys.argv.index("--topics") + 1])
        if "--daily" in sys.argv:
            cfg["mode"] = "daily"
        subs = {"<dry-run>": cfg}

    sent = 0

    def deliver(chat, text: str) -> bool:
        nonlocal sent
        try:
            for part in chunks(text):
                send(token, chat, part, dry)
            sent += 1
            return True
        except Blocked:
            subs.pop(str(chat), None)
            return False

    try:
        # 0. Меню команд в Telegram — один раз (и заново при изменении списка).
        cmd_ver = hashlib.sha1(json.dumps(COMMANDS).encode()).hexdigest()[:8]
        if not dry and state.get("commands") != cmd_ver:
            api(token, "setMyCommands", commands=json.dumps(
                [{"command": c, "description": d} for c, d in COMMANDS], ensure_ascii=False))
            state["commands"] = cmd_ver

        # 1. Подписки, отписки и настройки.
        updates = [] if dry else api(token, "getUpdates", offset=state["offset"], timeout=0,
                                     allowed_updates=json.dumps(["message"]))
        for u in updates:
            state["offset"] = u["update_id"] + 1
            msg = u.get("message") or {}
            chat = (msg.get("chat") or {}).get("id")
            raw = (msg.get("text") or "").strip()
            if not chat or (msg.get("chat") or {}).get("type") != "private":
                continue
            key = str(chat)
            if raw.lower().startswith("/stop"):
                subs.pop(key, None)
                deliver(chat, BYE)
                continue
            new = key not in subs
            cfg = subs.setdefault(key, {})
            reply = handle_command(raw, cfg)
            if new or raw.lower().startswith("/start"):
                deliver(chat, WELCOME)
            if reply:
                deliver(chat, reply)

        # 2. Новые обзоры недели — всем.
        recipients = list(subs) + ([extra_chat] if extra_chat else [])
        for issue in reversed(weekly["issues"]):
            if issue["id"] in state["reviews"]:
                continue
            for chat in recipients:
                deliver(chat, "\n\n".join(review_messages(issue)))
            state["reviews"].append(issue["id"])

        # 3. Лента. Общий блок «Главное» — для частого режима; ежедневная сводка — свой отбор за сутки.
        fresh = stories(news, src)
        posted = set(state["posted"])
        main_block = [s for s in fresh if s.key not in posted and s.score >= MIN_SCORE][:MAX_PER_POST]
        today = now.astimezone(MSK).date().isoformat()
        for chat, cfg in list(subs.items()):
            if cfg.get("mode") == "daily":
                if not dry and not daily_due(cfg, now):
                    continue
                text, keys = personal_message(fresh, src, fresh[:DAILY_TOP], cfg, set())
                cfg["last_daily"] = today
            else:
                text, keys = personal_message(fresh, src, main_block, cfg, posted)
            if text and deliver(chat, text) and keys:
                cfg["seen"] = (list(cfg.get("seen") or []) + keys)[-KEEP_SEEN:]
        if extra_chat and main_block:
            deliver(extra_chat, render("Главное в ленте", main_block, [], src))
        if main_block:
            state["posted"] = (state["posted"] + [s.key for s in main_block])[-KEEP_IDS:]
        print(f"Telegram: подписчиков {len(subs)}, сюжетов в общей рассылке {len(main_block)}, "
              f"отправлено сообщений {sent}")
    except Exception as exc:  # noqa: BLE001 — сбой Telegram не должен ронять сборку сайта
        print(f"Telegram: ошибка — {type(exc).__name__}: {exc}")
    finally:
        if not dry:
            state["subscribers"] = seal(subs, token)
            STATE.parent.mkdir(exist_ok=True)
            STATE.write_text(json.dumps(state, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
