# -*- coding: utf-8 -*-
"""Pinyin helper for the Host plugin.

Input (stdin, one JSON object):

    {"texts": ["钉宫病"], "manual": {"钉宫病": "ding1gong1bing4"}}

Output:

    {"pinyin": {"钉宫病": ["ding", "gong", "bing"]},
     "errors": {"K-ON": "含非汉字字符"}}

`manual` values are the user's pinned readings. They may carry tone digits
(`ding1gong1bing4`) or be plain (`dinggongbing`); they are normalised to
toneless syllables. The syllable count must equal the character count, which is
checked by segmenting against pypinyin's own syllable inventory.

    python pinyin_tool.py "钉宫病"            # one term, prints the array
"""

import json
import sys

from glossary import is_hanzi, syllables

_SYLLABLES = None


def syllable_inventory():
    """Every toneless syllable pypinyin knows (about 400 entries)."""
    global _SYLLABLES
    if _SYLLABLES is None:
        from pypinyin.pinyin_dict import pinyin_dict
        from pypinyin.contrib.tone_convert import to_normal
        found = set()
        for value in pinyin_dict.values():
            for reading in str(value).split(","):
                letters = "".join(ch for ch in to_normal(reading) if ch.isalpha()).lower()
                if letters:
                    found.add(letters)
        _SYLLABLES = found
    return _SYLLABLES


def segment(joined, count):
    """Split `joined` into exactly `count` syllables; None if impossible."""
    if count <= 0:
        return None
    from pypinyin.contrib.tone_convert import to_normal
    inventory = syllable_inventory()
    text = "".join(ch for ch in to_normal(joined) if ch.isalpha()).lower()
    if text == "":
        return None
    # dp[i][k] = the syllable list for text[:i] split into k pieces
    dp = [[None] * (count + 1) for _ in range(len(text) + 1)]
    dp[0][0] = []
    for end in range(1, len(text) + 1):
        for start in range(max(0, end - 8), end):
            piece = text[start:end]
            if piece not in inventory:
                continue
            for k in range(1, count + 1):
                if dp[start][k - 1] is None:
                    continue
                if dp[end][k] is None:
                    dp[end][k] = dp[start][k - 1] + [piece]
    return dp[len(text)][count]


def resolve(texts, manual):
    pinyin = {}
    errors = {}
    for text in texts:
        if not isinstance(text, str) or text == "":
            errors[str(text)] = "缺少词条"
            continue
        if not all(is_hanzi(ch) for ch in text):
            errors[text] = "含非汉字字符，请改用中文写法"
            continue
        pinned = manual.get(text) if isinstance(manual, dict) else None
        if isinstance(pinned, str) and pinned.strip() != "":
            pieces = segment(pinned, len(text))
            if pieces is None:
                errors[text] = f"拼音无法切成 {len(text)} 个音节：{pinned.strip()}"
                continue
            pinyin[text] = pieces
            continue
        try:
            auto = syllables(text)
        except Exception:                              # noqa: BLE001
            auto = None
        if auto is None:
            errors[text] = "自动注音失败"
            continue
        pinyin[text] = auto
    return pinyin, errors


def main():
    if len(sys.argv) > 1:
        result, _ = resolve([sys.argv[1]], {})
        sys.stdout.write(json.dumps(result.get(sys.argv[1]), ensure_ascii=False))
        return 0
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except ValueError as exc:
        sys.stdout.write(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 2
    texts = payload.get("texts") if isinstance(payload, dict) else None
    if not isinstance(texts, list):
        sys.stdout.write(json.dumps({"error": "send {\"texts\":[...]}"}, ensure_ascii=False))
        return 2
    pinyin, errors = resolve(texts, payload.get("manual") or {})
    sys.stdout.write(json.dumps({"pinyin": pinyin, "errors": errors}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
