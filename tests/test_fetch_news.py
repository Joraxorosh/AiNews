"""Тесты сборщика: чистка, ссылки, теги, склейка дублей, темы, фильтры, разбор лент.

Запуск: python -m unittest discover -s tests
"""
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import fetch_news as f  # noqa: E402

T0 = datetime(2026, 11, 25, 12, 0, tzinfo=timezone.utc)


def item(id_, title, source, hours=0, link=None, summary=""):
    return {
        "id": id_, "title": title, "summary": summary, "source": source,
        "link": link or f"https://example.com/{source}/{id_}",
        "published": (T0 + timedelta(hours=hours)).isoformat(),
    }


# Фон: склейка взвешивает слова по редкости во всей ленте (IDF), поэтому тестовые
# новости кладём в «ленту» из посторонних заголовков — как в реальном news.json.
FILLER = [
    "PostgreSQL 19 released with faster vacuum", "Rust 2.0 roadmap published by the core team",
    "Apple updates Swift concurrency model", "Kubernetes 2.3 brings sidecar containers GA",
    "Mozilla ships Firefox 160 with new tab grouping", "Linux kernel 7.4 merges new scheduler",
    "Cloudflare outage hits DNS resolvers in Europe", "Microsoft patches Exchange zero-day",
    "Google Chrome adds passkey sync across devices", "Docker Desktop changes licensing terms",
    "NVIDIA announces new data center GPUs", "Meta opens Muse assistant to Instagram DMs",
    "SpaceX launches Starmind satellites", "Tesla recalls cars over software bug",
    "GitHub Actions adds larger runners", "Python 3.15 beta brings JIT improvements",
    "Ubuntu security response times criticised", "WordPress removes backdoored plugins",
    "Drupal warns of critical site takeover flaw", "VMware vCenter auth bypass patched",
    "OpenRouter drops providers over leaked prompts", "1Password discloses security incident",
    "Hex.pm package registry servers compromised", "Palo Alto warns of PAN-OS attacks",
    "Qwen 3.8 tops open model leaderboard", "DeepSeek V4.1 Flash now in Yandex AI Studio",
    "Gemini 4 Neon beats Carbon on benchmarks", "Claude Ship reviews pull requests",
    "Ollama adds Inkling 2 Mini support", "LangChain releases core 1.8.5",
]


def groups_of(items):
    items = items + [item(f"bg{i}", t, f"bg{i}", -48 - i * 3) for i, t in enumerate(FILLER)]
    f.assign_groups(items)
    out = {}
    for it in items:
        out.setdefault(it.get("group", it["id"]), set()).add(it["id"])
    return [g for g in out.values() if len(g) > 1]


class CleanAndLinks(unittest.TestCase):
    def test_clean_strips_tags_scripts_and_entities(self):
        self.assertEqual(f.clean("<p>a<script>evil()</script> &lt;select&gt; b</p>"), "a <select> b")

    def test_clean_truncates_on_word_boundary(self):
        out = f.clean("один два три четыре пять", limit=12)
        self.assertTrue(out.endswith("…"))
        self.assertLessEqual(len(out), 13)

    def test_link_key_drops_tracking_keeps_meaningful_params(self):
        self.assertEqual(f.link_key("https://www.habr.com/ru/articles/1/?utm_source=x&p=5"), "habr.com/ru/articles/1?p=5")
        self.assertNotEqual(f.link_key("https://scottaaronson.blog/?p=10379"), f.link_key("https://scottaaronson.blog/?p=10362"))
        self.assertEqual(f.link_key("https://a.com/x?fbclid=1"), f.link_key("https://a.com/x/"))

    def test_parse_date_formats(self):
        self.assertEqual(f.parse_date("Tue, 25 Nov 2026 12:00:00 GMT"), T0)
        self.assertEqual(f.parse_date("2026-11-25T12:00:00Z"), T0)
        self.assertIsNone(f.parse_date("вчера"))


class Tags(unittest.TestCase):
    def test_security_words(self):
        for title in ["Hackers stole credentials", "Хакеры атаковали банк", "Critical CVE-2026-1234 exploited"]:
            self.assertIn("безопасность", f.tags_for(title, "", "it"), title)

    def test_hackathon_is_not_security(self):
        self.assertNotIn("безопасность", f.tags_for("Hackathon results", "", "it"))

    def test_science_gets_research_tag_without_release(self):
        tags = f.tags_for("We introduce a new model", "", "science")
        self.assertEqual(tags[0], "исследование")
        self.assertNotIn("релиз", tags)


class Tidy(unittest.TestCase):
    def test_arxiv_prefix(self):
        it = item("a", "Paper", "arxiv-cl", summary="arXiv:2611.1v1 Announce Type: new Abstract: We study X.")
        f.tidy(it)
        self.assertEqual(it["summary"], "We study X.")

    def test_hn_meta_extracted(self):
        it = item("h", "Show HN", "hn", summary="Article URL: https://x.dev Comments URL: https://news.ycombinator.com/item?id=1 Points: 263 # Comments: 143")
        f.tidy(it)
        self.assertEqual((it["points"], it["comments"], it["summary"]), (263, 143, ""))
        self.assertEqual(it["discussion"], "https://news.ycombinator.com/item?id=1")

    def test_habr_and_release_junk(self):
        a = item("1", "T", "habr-ai", summary="Интересный текст. Читать далее")
        b = item("2", "T", "gh-claude-code", summary="What's changed Added X")
        f.tidy(a)
        f.tidy(b)
        self.assertEqual(a["summary"], "Интересный текст.")
        self.assertEqual(b["summary"], "Added X")

    def test_url_only_or_title_repeat_removed(self):
        a = item("1", "T", "gh-vscode", summary="https://code.visualstudio.com/updates/v1_148")
        b = item("2", "Same", "x", summary="Same")
        f.tidy(a)
        f.tidy(b)
        self.assertEqual((a["summary"], b["summary"]), ("", ""))

    def test_idempotent(self):
        it = item("h", "T", "hn", summary="Comments URL: https://n/1 Points: 5 # Comments: 2")
        f.tidy(it)
        f.tidy(it)
        self.assertEqual(it["points"], 5)


class Dedup(unittest.TestCase):
    def test_same_story_from_three_sources(self):
        items = [
            item("1", "Hackers Compromise 24 Check Point Management Servers in Suspected AI-Driven Attack Campaign", "thehackernews"),
            item("2", "Active intrusion campaign against Check Point security management servers", "hn", 1),
            item("3", "Hackers compromise Check Point Servers in 22 organizations", "bleeping", 2),
        ]
        groups = groups_of(items)
        # Два явных пересказа склеиваются всегда; пересказ с HN (меньше общих редких слов)
        # присоединяется в зависимости от остальной ленты — но только к этой же группе.
        self.assertEqual(len(groups), 1)
        self.assertTrue({"1", "3"} <= groups[0] <= {"1", "2", "3"})

    def test_template_words_do_not_merge_different_stories(self):
        items = [
            item("1", "McDonald's Japan data breach exposes customer location information", "bleeping"),
            item("2", "WHMCS SQL Injection Could Expose Customer Data and Admin Password Hashes without Login", "thehackernews"),
        ]
        self.assertEqual(groups_of(items), [])

    def test_same_source_never_merged(self):
        items = [item("1", "vLLM v0.11.0 released with new kernels", "gh-vllm"),
                 item("2", "vLLM v0.11.1 released with new kernels", "gh-vllm", 1)]
        self.assertEqual(groups_of(items), [])

    def test_same_link_merges(self):
        link = "https://openai.com/index/gpt-6-protein?utm_source=rss"
        items = [item("1", "GPT-6 models demonstrate intrinsic protein-design capabilities", "openai", link=link),
                 item("2", "Totally different headline here", "hn", 2, link="https://openai.com/index/gpt-6-protein")]
        self.assertEqual(groups_of(items), [{"1", "2"}])

    def test_outside_time_window_not_merged(self):
        items = [item("1", "Gemini 4 Argon: Built to solve your hardest problems", "deepmind"),
                 item("2", "Gemini 4 Argon: Built to solve your hardest problems", "googleai", 24 * 5)]
        self.assertEqual(groups_of(items), [])

    def test_different_arxiv_papers_not_merged(self):
        items = [item("1", "Large language models for reasoning about tables", "arxiv-cl", link="https://arxiv.org/abs/2611.00001"),
                 item("2", "Large language models for reasoning about tables", "arxiv-lg", link="https://arxiv.org/abs/2611.00002")]
        self.assertEqual(groups_of(items), [])


class Topics(unittest.TestCase):
    def test_auto_category(self):
        cases = [
            ({"title": "1Password hacked", "summary": "", "tags": ["безопасность"]}, "it"),
            ({"title": "Claude Code adds skills", "summary": "", "tags": []}, "tools"),
            ({"title": "GPT-6.2 Astra beats records", "summary": "", "tags": []}, "models"),
            ({"title": "A few questions about a pond", "summary": "", "tags": []}, "it"),
        ]
        for it, want in cases:
            self.assertEqual(f.auto_category(it, "it"), want, it["title"])

    def test_habr_ai_filter(self):
        rx = f.TOPIC_FILTERS["ai"]
        self.assertTrue(rx.search("Новая модель Qwen для кода"))
        self.assertTrue(rx.search("ИИ-агенты в бизнесе"))
        self.assertFalse(rx.search("Как мы перестали приклеивать кастрюли к кухне"))
        self.assertFalse(rx.search("Mail сервер на FreeBSD"))


class Feeds(unittest.TestCase):
    RSS = b"""<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>Hello &amp; world</title><link>https://a.com/1</link>
      <pubDate>Tue, 25 Nov 2026 12:00:00 GMT</pubDate><description>&lt;p&gt;Text&lt;/p&gt;</description></item>
    </channel></rss>"""
    ATOM = b"""<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title>v1.2.0</title><link rel="alternate" href="https://g.com/r/1"/>
      <updated>2026-11-25T12:00:00Z</updated><content>Notes</content></entry></feed>"""

    def test_rss(self):
        (e,) = f.parse_feed(self.RSS)
        self.assertEqual((e["title"], e["link"]), ("Hello & world", "https://a.com/1"))
        self.assertEqual(f.clean(e["summary"]), "Text")

    def test_atom(self):
        (e,) = f.parse_feed(self.ATOM)
        self.assertEqual((e["title"], e["link"], e["summary"]), ("v1.2.0", "https://g.com/r/1", "Notes"))


class SourcesConfig(unittest.TestCase):
    def test_sources_json_is_consistent(self):
        import json
        data = json.loads(f.SOURCES_FILE.read_text(encoding="utf-8"))["sources"]
        ids = [s["id"] for s in data]
        self.assertEqual(len(ids), len(set(ids)), "повторяющиеся id")
        for s in data:
            self.assertIn(s["category"], {"models", "tools", "science", "it"}, s["id"])
            self.assertTrue(s["url"].startswith("https://"), s["id"])
            if "require" in s:
                self.assertIn(s["require"], f.TOPIC_FILTERS, s["id"])


if __name__ == "__main__":
    unittest.main()
