"""PyInstaller runtime hook: engine pipes use UTF-8 on every Windows locale."""

import sys

for stream in (sys.stdin, sys.stdout, sys.stderr):
    if stream is not None:
        stream.reconfigure(encoding="utf-8")
