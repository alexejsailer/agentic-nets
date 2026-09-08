"""Every scout script must carry the shared block verbatim (the executor runs single files)."""
import glob, os, unittest
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
START = "# >>> shared: scoutlib (generated, do not edit here)\n"; END = "# <<< shared: scoutlib\n"


class SharedSync(unittest.TestCase):
    def test_every_script_has_the_canonical_block(self):
        lib = open(os.path.join(HERE, "scoutlib.py")).read()
        if not lib.endswith("\n"):
            lib += "\n"
        scripts = sorted(glob.glob(os.path.join(HERE, "scout-*.py")))
        self.assertGreaterEqual(len(scripts), 9)
        for fn in scripts:
            s = open(fn).read()
            a, b = s.find(START), s.find(END)
            self.assertGreater(a, -1, fn); self.assertGreater(b, a, fn)
            self.assertEqual(s[a + len(START):b], lib, "%s: shared block drifted; run tools/inline-shared.py" % os.path.basename(fn))
            self.assertEqual(s.count("def api("), 1, fn)

    def test_service_token_only_on_backend_calls(self):
        for fn in sorted(glob.glob(os.path.join(HERE, "scout-*.py"))):
            lines = open(fn).read().split("\n")
            for i, l in enumerate(lines):
                if "X-Service-Auth" in l and "add_header" in l:
                    ctx = "\n".join(lines[max(0, i - 8):i])
                    self.assertTrue("MASTER +" in ctx or "BLOBS +" in ctx, "%s:%d token header outside api()/put_blob" % (fn, i + 1))


if __name__ == "__main__":
    unittest.main()
