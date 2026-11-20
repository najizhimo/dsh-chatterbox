# -*- coding: utf-8 -*-
"""Glossary support for ptt.py: rewrite homophone misrecognitions of known terms.

The glossary is a JSON file written by the Host plugin:

    {"terms": [{"text": "钉宫病", "pinyin": ["ding", "gong", "bing"], "source": "manual"}]}

`pinyin` is optional: when present it pins the reading (the user typed
`钉宫病=dinggongbing`), otherwise pypinyin generates it. Matching compares
toneless syllables, so tone digits on input are accepted and dropped.

The file is re-read whenever its mtime changes, so adding a term takes effect on
the next utterance — no restart.
"""

import json

GLOSSARY_MAX_TERMS = 500
GLOSSARY_MAX_CHARS = 24


def load_pinyin():
    """Import pypinyin lazily: --help and device listing must not pay for it."""
    from pypinyin import pinyin, Style
    return pinyin, Style


def is_hanzi(ch):
    code = ord(ch)
    return 0x4E00 <= code <= 0x9FFF or 0x3400 <= code <= 0x4DBF or 0xF900 <= code <= 0xFAFF


def toneless(value):
    return "".join(ch for ch in str(value) if ch.isalpha()).lower()


def hanzi_runs(text):
    """Yield (is_chinese, chunk) so pinyin is only computed for Chinese runs."""
    if text == "":
        return
    start = 0
    current = is_hanzi(text[0])
    for index in range(1, len(text)):
        flag = is_hanzi(text[index])
        if flag != current:
            yield current, text[start:index]
            start = index
            current = flag
    yield current, text[start:]


def syllables(text, pinyin=None, Style=None):
    """Toneless syllables, one per character (None when alignment fails)."""
    if pinyin is None or Style is None:
        pinyin, Style = load_pinyin()
    try:
        values = pinyin(text, style=Style.TONE3, neutral_tone_with_five=True)
    except Exception:                                  # noqa: BLE001
        return None
    parts = []
    for item in values:
        if isinstance(item, (list, tuple)):
            value = item[0] if item else ""
        else:
            value = item
        parts.append(toneless(value))
    if len(parts) != len(text) or any(part == "" for part in parts):
        return None
    return parts


# Kept for callers that used the old name.
run_pinyin = syllables


class Glossary:
    """A JSON list of terms, reloaded when the file's mtime changes."""

    def __init__(self, path, log):
        self.path = path
        self.log = log
        self.mtime = object()          # sentinel: force the first load
        self.entries = []
        self.error = ""

    def refresh(self):
        try:
            mtime = self.path.stat().st_mtime
        except OSError:
            mtime = None
        if mtime == self.mtime:
            return
        self.mtime = mtime
        if mtime is None:
            self.entries = []
            return
        try:
            pinyin, Style = load_pinyin()
        except Exception as exc:                       # noqa: BLE001
            self.error = f"pypinyin unavailable: {exc}"
            self.entries = []
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8") or "{}")
        except (OSError, ValueError, TypeError) as exc:
            self.error = f"bad glossary json: {exc}"
            self.entries = []
            return
        terms = data.get("terms") if isinstance(data, dict) else None
        entries = []
        for item in terms or []:
            if isinstance(item, dict):
                text = item.get("text")
                pinned = item.get("pinyin")
            else:
                text, pinned = item, None
            text = (text or "").strip()
            if not text or len(text) > GLOSSARY_MAX_CHARS:
                continue
            parts = None
            if isinstance(pinned, list) and len(pinned) == len(text):
                candidate = [toneless(part) for part in pinned]
                if all(candidate):
                    parts = candidate
            if parts is None:
                parts = syllables(text, pinyin, Style)
            if parts is None:
                continue
            entries.append((text, parts))
        # Longest first so 「灼眼的夏娜」 wins over a shorter overlapping term.
        entries.sort(key=lambda entry: len(entry[0]), reverse=True)
        self.entries = entries
        self.error = ""

    def apply(self, text):
        self.refresh()
        if not self.entries or not text:
            return text
        try:
            pinyin, Style = load_pinyin()
        except Exception:                              # noqa: BLE001
            return text
        out = []
        for is_chinese, run in hanzi_runs(text):
            if not is_chinese:
                out.append(run)
                continue
            chars = list(run)
            tones = syllables(run, pinyin, Style)
            if tones is None:
                out.append(run)
                continue
            index = 0
            while index < len(chars):
                hit = None
                for term, term_py in self.entries:
                    size = len(term_py)
                    if index + size > len(chars):
                        continue
                    if tones[index:index + size] == term_py:
                        hit = term
                        break
                if hit is None:
                    out.append(chars[index])
                    index += 1
                else:
                    out.append(hit)
                    index += len(hit)
        result = "".join(out)
        if result != text and self.log is not None:
            self.log(f"glossary: {text!r} → {result!r}")
        return result
