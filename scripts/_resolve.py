import re
import sys

# Resolves conflict hunks by keeping both sides (HEAD first, then ours),
# or by a chooser per file passed on the command line.
p = sys.argv[1]
mode = sys.argv[2] if len(sys.argv) > 2 else "both"
s = open(p).read()
pattern = re.compile(r"<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n", re.S)


def choose(m):
    head, ours = m.group(1), m.group(2)
    if mode == "both":
        return head + ours
    if mode == "ours":
        return ours
    if mode == "head":
        return head
    raise SystemExit(f"unknown mode {mode}")


out, n = pattern.subn(choose, s)
open(p, "w").write(out)
print(f"{p}: {n} hunk(s) resolved with {mode}")
