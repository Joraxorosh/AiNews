"""Тесты рассылки в Telegram (без сети): шифрование подписчиков, разбиение текста, отбор сюжетов."""
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import telegram_post as t  # noqa: E402

NOW = datetime.now(timezone.utc)
SRC = {
    "openai": {"name": "OpenAI News", "weight": 2},
    "verge": {"name": "The Verge"},
    "techcrunch": {"name": "TechCrunch"},
    "arxiv-cl": {"name": "arXiv", "family": "arxiv"},
}


def it(id_, source, tags=(), hours_ago=1, group=None, title=None):
    d = {"id": id_, "title": title or f"Story {id_}", "link": f"https://x.com/{id_}", "source": source,
         "category": "models", "tags": list(tags),
         "published": (NOW - timedelta(hours=hours_ago)).isoformat(),
         "first_seen": (NOW - timedelta(hours=hours_ago)).isoformat()}
    if group:
        d["group"] = group
    return d


class Seal(unittest.TestCase):
    def test_roundtrip(self):
        blob = t.seal([123, -100500], "token-A")
        self.assertEqual(t.unseal(blob, "token-A"), [-100500, 123])

    def test_wrong_token(self):
        self.assertIsNone(t.unseal(t.seal([1], "token-A"), "token-B"))

    def test_empty(self):
        self.assertEqual(t.unseal("", "x"), [])

    def test_ids_not_visible(self):
        self.assertNotIn("123456789", t.seal([123456789], "token-A"))


class Chunks(unittest.TestCase):
    def test_split_under_limit(self):
        parts = t.chunks("a" * 3000 + "\n\n" + "b" * 3000)
        self.assertEqual(len(parts), 2)
        self.assertTrue(all(len(p) <= 3900 for p in parts))


class Picking(unittest.TestCase):
    def test_picks_important_skips_weak_posted_old_arxiv(self):
        news = {"items": [
            it("big1", "verge", ["модель", "релиз"], group="g1"), it("big2", "techcrunch", group="g1"),  # 2 источника
            it("off", "openai", ["релиз", "модель"]),                       # официальный блог
            it("weak", "verge"),                                            # низкая важность
            it("posted", "openai", ["релиз", "безопасность"]),             # уже отправлен
            it("old", "openai", ["релиз", "безопасность"], hours_ago=48),  # старый
            it("paper", "arxiv-cl", ["релиз", "безопасность", "модель"]),  # arXiv не шлём
        ]}
        msg, keys = t.news_message(news, SRC, {"posted"})
        self.assertEqual(set(keys), {"g1", "off"})
        self.assertIn("2 источника", msg)
        self.assertNotIn("Story weak", msg)

    def test_nothing_to_send(self):
        self.assertEqual(t.news_message({"items": [it("weak", "verge")]}, SRC, set()), (None, []))

    def test_html_is_escaped(self):
        news = {"items": [it("x", "openai", ["релиз", "модель"], title="<b>A & B</b>")]}
        msg, _ = t.news_message(news, SRC, set())
        self.assertIn("&lt;b&gt;A &amp; B&lt;/b&gt;", msg)


class Personal(unittest.TestCase):
    NEWS = {"items": [
        it("big", "openai", ["релиз", "модель"], title="GPT-7 released"),
        it("gc", "verge", title="GigaChat 4 получил агентов"),            # неважная, но по теме
        it("cve", "verge", title="Уязвимость в nginx", hours_ago=2),
        it("paper", "arxiv-cl", title="GigaChat paper"),                  # arXiv не шлём и по темам
        it("old", "verge", title="GigaChat old", hours_ago=48),
        dict(it("backlog", "verge", title="GigaChat backlog", hours_ago=24 * 30), first_seen=NOW.isoformat()),  # архив нового источника
    ]}

    def test_parse_topics(self):
        self.assertEqual(t.parse_topics(" Claude  Code, gigachat;GigaChat , «уязвимость», x"),
                         ["Claude Code", "gigachat", "уязвимость"])

    def test_topics_block_and_seen(self):
        fresh = t.stories(self.NEWS, SRC)
        main = [s for s in fresh if s.score >= t.MIN_SCORE]
        cfg = {"topics": ["gigachat", "уязвимост"]}
        msg, keys = t.personal_message(fresh, SRC, main, cfg, set())
        self.assertIn("Главное в ленте", msg)
        self.assertIn("По вашим темам", msg)
        self.assertIn("GigaChat 4", msg)
        self.assertNotIn("paper", msg)
        self.assertNotIn("old", msg)
        self.assertNotIn("backlog", msg)
        self.assertEqual(set(keys), {"gc", "cve"})
        # Уже присланное по темам не повторяется; без общего блока и без новых тем — молчим.
        cfg["seen"] = keys
        self.assertEqual(t.personal_message(fresh, SRC, [], cfg, set()), (None, []))

    def test_no_topics_same_as_before(self):
        fresh = t.stories(self.NEWS, SRC)
        msg, keys = t.personal_message(fresh, SRC, [], {}, set())
        self.assertIsNone(msg)

    def test_commands(self):
        cfg = {}
        self.assertIn("Claude Code", t.handle_command("/topics Claude Code, GigaChat", cfg))
        self.assertEqual(cfg["topics"], ["Claude Code", "GigaChat"])
        t.handle_command("/daily@AiNewsBot", cfg)
        self.assertEqual(cfg["mode"], "daily")
        self.assertIn("Claude Code", t.handle_command("/settings", cfg))
        t.handle_command("/often", cfg)
        t.handle_command("/topics off", cfg)
        self.assertEqual(cfg, {})
        self.assertIsNone(t.handle_command("/start", cfg))
        self.assertIsNone(t.handle_command("привет", cfg))

    def test_daily_due(self):
        morning = datetime(2026, 11, 26, 6, 0, tzinfo=timezone.utc)   # 9:00 МСК
        night = datetime(2026, 11, 26, 2, 0, tzinfo=timezone.utc)     # 5:00 МСК
        self.assertTrue(t.daily_due({}, morning))
        self.assertFalse(t.daily_due({}, night))
        self.assertFalse(t.daily_due({"last_daily": "2026-11-26"}, morning))

    def test_legacy_and_new_state(self):
        self.assertEqual(t.load_subs(t.seal([5, 7], "tok"), "tok"), {"5": {}, "7": {}})
        subs = {"5": {"topics": ["Ёж"], "mode": "daily"}}
        self.assertEqual(t.load_subs(t.seal(subs, "tok"), "tok"), subs)
        self.assertNotIn("Ёж", t.seal(subs, "tok"))


if __name__ == "__main__":
    unittest.main()
