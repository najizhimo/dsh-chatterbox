# -*- coding: utf-8 -*-
"""Self-test for the glossary matcher (no microphone, no model).

    python glossary.py                # built-in cases
    python glossary.py "丁宫病"        # apply the glossary next to this file
"""

import json
import pathlib
import sys
import tempfile

from glossary import Glossary


def run(log_path=None):
    errors = []
    with tempfile.TemporaryDirectory() as tmp:
        path = pathlib.Path(tmp) / "glossary.json"
        path.write_text(json.dumps({"terms": [
            {"text": "钉宫病"},
            {"text": "灼眼的夏娜"},
            {"text": "西园寺风莉"},
        ]}, ensure_ascii=False), encoding="utf-8")
        glossary = Glossary(path, log=None)

        cases = [
            ("我得了丁宫病", "我得了钉宫病"),
            ("最近在看灼眼的夏娜", "最近在看灼眼的夏娜"),
            ("着眼的夏娜真好看", "灼眼的夏娜真好看"),
            ("钉工病又犯了", "钉宫病又犯了"),
            ("卓眼的夏那", "灼眼的夏娜"),
            ("西园寺风莉在吗", "西园寺风莉在吗"),
            ("今天天气不错", "今天天气不错"),
            ("OK 钉宫病 OK", "OK 钉宫病 OK"),
        ]
        for source, expected in cases:
            actual = glossary.apply(source)
            if actual != expected:
                errors.append(f"{source!r}: expected {expected!r}, got {actual!r}")
        # A term at the very start/end still matches.
        for source, expected in [("丁宫病", "钉宫病"), ("啊啊丁宫病", "啊啊钉宫病")]:
            actual = glossary.apply(source)
            if actual != expected:
                errors.append(f"{source!r}: expected {expected!r}, got {actual!r}")
        # Pinned pinyin overrides the automatic reading (阿倍=abai).
        path.write_text(json.dumps({"terms": [
            {"text": "阿倍", "pinyin": ["a", "bai"]},
        ]}, ensure_ascii=False), encoding="utf-8")
        glossary.mtime = object()
        for source, expected in [("阿白来了", "阿倍来了"), ("阿北来了", "阿北来了")]:
            actual = glossary.apply(source)
            if actual != expected:
                errors.append(f"pinned {source!r}: expected {expected!r}, got {actual!r}")
        # Removing every term disables rewriting.
        path.write_text(json.dumps({"terms": []}), encoding="utf-8")
        glossary.mtime = object()
        if glossary.apply("我得了丁宫病") != "我得了丁宫病":
            errors.append("empty glossary must not rewrite")
    return errors


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--stdin":
        data = json.loads(sys.stdin.read())
        path = pathlib.Path(data["path"])
        glossary = Glossary(path, log=print)
        print(glossary.apply(data["text"]))
        sys.exit(0)
    failures = run()
    for line in failures:
        print("FAIL " + line)
    print("GLOSSARY OK" if not failures else f"{len(failures)} FAILED")
    sys.exit(0 if not failures else 1)
