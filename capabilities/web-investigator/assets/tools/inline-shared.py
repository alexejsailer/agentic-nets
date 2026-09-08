#!/usr/bin/env python3
"""Copy assets/scoutlib.py verbatim into every scout-*.py between the shared markers.
Idempotent. The executor runs each script as a single file, so this is how the shared code ships."""
import glob, os, sys
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
START = "# >>> shared: scoutlib (generated, do not edit here)\n"
END = "# <<< shared: scoutlib\n"
lib = open(os.path.join(HERE, "scoutlib.py")).read()
if not lib.endswith("\n"):
    lib += "\n"
changed = 0
for fn in sorted(glob.glob(os.path.join(HERE, "scout-*.py"))):
    s = open(fn).read()
    a, b = s.find(START), s.find(END)
    if a < 0 or b < 0 or b < a:
        print("no markers in", os.path.basename(fn)); sys.exit(1)
    new = s[:a + len(START)] + lib + s[b:]
    if new != s:
        open(fn, "w").write(new); changed += 1
print("inlined into %d file(s) changed" % changed)
