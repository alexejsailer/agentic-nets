#!/usr/bin/env python3
"""Inline a pack's shared Python library into each of its scripts between the shared markers.
The executor materialises a registered script as ONE file, so sibling imports do not exist at
run time; this is how shared code ships. Idempotent.

usage: inline-shared.py <pack-dir> <libname>      e.g. inline-shared.py hermann hermannlib
Scripts are assets/<prefix>-*.py where <prefix> is the libname without the trailing 'lib'."""
import glob, os, sys
if len(sys.argv) != 3:
    print(__doc__); sys.exit(2)
pack, lib = sys.argv[1], sys.argv[2]
assets = os.path.join(os.path.abspath(pack), "assets")
prefix = lib[:-3] if lib.endswith("lib") else lib
START = "# >>> shared: %s (generated, do not edit here)\n" % lib
END = "# <<< shared: %s\n" % lib
src = open(os.path.join(assets, lib + ".py")).read()
if not src.endswith("\n"):
    src += "\n"
changed = 0
for fn in sorted(glob.glob(os.path.join(assets, prefix + "-*.py"))):
    s = open(fn).read()
    a, b = s.find(START), s.find(END)
    if a < 0 or b < 0 or b < a:
        print("no markers in", os.path.basename(fn)); sys.exit(1)
    new = s[:a + len(START)] + src + s[b:]
    if new != s:
        open(fn, "w").write(new); changed += 1
print("inlined %s into %d file(s) changed" % (lib, changed))
