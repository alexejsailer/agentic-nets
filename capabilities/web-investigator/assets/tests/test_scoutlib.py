import gzip, io, json, os, socket, sys, unittest
from unittest import mock
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
import scoutlib as L


class CanonicalUrl(unittest.TestCase):
    def test_six_variants_collapse(self):
        base = "https://example.com/a/b"
        variants = ["https://example.com/a/b/", "http://example.com/a/b", "https://www.example.com/a/b",
                    "https://EXAMPLE.com/a/b?utm_source=rss&utm_medium=x", "https://example.com/a/b#section",
                    "https://example.com:443/a/b?fbclid=1"]
        keys = {L.canonical_url(v) for v in variants}
        # http vs https stay distinct on scheme by design? No: scheme is part of the key. Check the rest.
        https_only = {k for k in keys if k.startswith("https://")}
        self.assertEqual(https_only, {"https://example.com/a/b"})
        self.assertEqual(L.canonical_url("http://example.com/a/b"), "http://example.com/a/b")

    def test_keeps_meaningful_params_sorted(self):
        self.assertEqual(L.canonical_url("https://x.org/p?b=2&a=1&utm_campaign=z"), "https://x.org/p?a=1&b=2")
        self.assertEqual(L.canonical_url("https://x.org/"), "https://x.org/")
        self.assertEqual(L.canonical_url("https://x.org/?p=123"), "https://x.org/?p=123")


class SafeUrl(unittest.TestCase):
    def test_rejects(self):
        for u, why in (("file:///etc/passwd", "scheme"), ("ftp://x.org/a", "scheme"), ("http://user:pw@x.org/", "credentials"),
                       ("http://x.org:8080/", "port"), ("http://169.254.169.254/latest", "blocked-address"),
                       ("http://127.0.0.1:80/", "blocked-address"), ("http://10.0.0.5/", "blocked-address"),
                       ("http://localhost/", "internal-name"), ("http://[::1]/", "blocked-address")):
            ok, reason = L.safe_url(u)
            self.assertFalse(ok, u); self.assertEqual(reason, why, u)

    def test_accepts_public_name(self):
        with mock.patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("93.184.216.34", 0))]):
            self.assertEqual(L.safe_url("https://example.com/x"), (True, "ok"))

    def test_name_resolving_to_private_is_blocked(self):
        with mock.patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("192.168.1.9", 0))]):
            self.assertEqual(L.safe_url("https://internal.example.com/")[1], "blocked-address")

    def test_dns_failure(self):
        with mock.patch("socket.getaddrinfo", side_effect=socket.gaierror("nope")):
            self.assertEqual(L.safe_url("https://nope.invalid/")[1], "dns")


class Gunzip(unittest.TestCase):
    def test_bomb_is_capped_without_expanding(self):
        bomb = gzip.compress(b"\0" * 50_000_000)   # ~50 KB compressed, 50 MB expanded
        self.assertLess(len(bomb), 200_000)
        with self.assertRaises(L.SizeCapped):
            L.gunzip_bounded(bomb, 2_000_000)

    def test_normal_roundtrip(self):
        self.assertEqual(L.gunzip_bounded(gzip.compress(b"hello world" * 100), 10_000), b"hello world" * 100)

    def test_corrupt(self):
        with self.assertRaises(L.CorruptEncoding):
            L.gunzip_bounded(b"\x1f\x8bnot really gzip at all", 1000)


class DecodeBody(unittest.TestCase):
    def test_windows_1252_roundtrip(self):
        raw = "café “typographic” quotes".encode("cp1252")
        text, codec, ratio = L.decode_body(raw, "text/html; charset=windows-1252")
        self.assertEqual(text, "café “typographic” quotes"); self.assertEqual(codec, "windows-1252"); self.assertEqual(ratio, 0.0)

    def test_meta_charset_sniffed(self):
        raw = b"<html><head><meta charset=iso-8859-1></head><body>caf\xe9</body></html>"
        text, codec, _ = L.decode_body(raw, "text/html")
        self.assertIn("café", text); self.assertEqual(codec, "cp1252")

    def test_replacement_fallback(self):
        text, codec, ratio = L.decode_body(b"\x81\x8d\x8f ok", "text/html; charset=utf-8")  # undefined in cp1252 too
        self.assertEqual(codec, "utf-8-replace"); self.assertGreater(ratio, 0)


class Dates(unittest.TestCase):
    def test_iso_anchored(self):
        self.assertIsNotNone(L.parse_date("2025-07-03T10:00:00Z"))
        self.assertIsNone(L.parse_date("build-v2023-01-01-final"))
        self.assertIsNone(L.parse_date("Wed, 21 Oct 2015 07:28:00 GMT"))

    def test_http_date(self):
        self.assertEqual(L.parse_http_date("Wed, 21 Oct 2015 07:28:00 GMT").year, 2015)
        self.assertIsNone(L.parse_http_date("garbage"))


class Brief(unittest.TestCase):
    def test_normalise_forms(self):
        for v in ('["a.com","b.org"]', "a.com, b.org", ["a.com", "b.org"]):
            self.assertEqual(L.normalise_brief({"denyHosts": v})["denyHosts"], ["a.com", "b.org"])

    def test_active_selection(self):
        toks = [{"data": {"briefId": "old", "active": "false"}}, {"data": {"briefId": "new"}}, {"data": {"briefId": "paused", "active": "false"}}]
        with mock.patch.object(L, "tokens_with_meta", return_value=toks):
            self.assertEqual(L.load_brief(allow_env=False)["briefId"], "new")

    def test_brief_json_env_wins_and_malformed_is_recorded(self):
        with mock.patch.dict(os.environ, {"BRIEF_JSON": '{"briefId":"env","mustInclude":"a, b"}'}):
            self.assertEqual(L.load_brief()["mustInclude"], ["a", "b"])
        L.LIB_ERRORS.clear()
        with mock.patch.dict(os.environ, {"BRIEF_JSON": "{not json"}), mock.patch.object(L, "tokens_with_meta", return_value=[]):
            self.assertEqual(L.load_brief(), {})
        self.assertTrue(any("BRIEF_JSON" in e for e in L.LIB_ERRORS))


class Rows(unittest.TestCase):
    def test_error_is_recorded_not_hidden(self):
        L.LIB_ERRORS.clear()
        with mock.patch.object(L, "api", side_effect=L.MasterError(401, "unauthorized")):
            self.assertEqual(L.rows("p-x", 10), [])
        self.assertEqual(len(L.LIB_ERRORS), 1); self.assertIn("401", L.LIB_ERRORS[0])
        with mock.patch.object(L, "api", side_effect=L.MasterError(404, "no place")):
            with self.assertRaises(L.MasterError):
                L.rows("p-x", 10, critical=True)


class Sentences(unittest.TestCase):
    def test_capital_start_skips_lowercase_chrome(self):
        text = "menu home about | This is a perfectly ordinary sentence that goes on for a while. More here!"
        self.assertTrue(L.article_body(text, "").startswith("This is a perfectly"))

    def test_lowercase_page_still_yields_a_body(self):
        text = "menu | this is a perfectly ordinary sentence that goes on for a while and ends here. more!"
        self.assertTrue(L.article_body(text, "").startswith("menu | this is"))


if __name__ == "__main__":
    unittest.main()
