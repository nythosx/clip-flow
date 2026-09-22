import argparse
import os
import sys

DEFAULT_EXCLUDE_DIRS = {
    ".git", "vendor", "node_modules", "build", "DerivedData",
    ".swiftpm", "Pods", "__pycache__", ".idea", ".vscode", ".build",
    "target", "dist", ".next", "gen",
}

PHP_IDENT_START = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_")
PHP_IDENT_CHARS = PHP_IDENT_START | set("0123456789")


def _consume_quoted(text, i, quote):
    n = len(text)
    out = [text[i]]
    i += 1
    while i < n:
        c = text[i]
        out.append(c)
        if c == "\\" and i + 1 < n:
            out.append(text[i + 1])
            i += 2
            continue
        if c == quote:
            i += 1
            break
        i += 1
    return "".join(out), i


def _match_heredoc_start(text, i):
    n = len(text)
    if text[i:i + 3] != "<<<":
        return None
    j = i + 3
    while j < n and text[j] in " \t":
        j += 1
    nowdoc = False
    quote = None
    if j < n and text[j] in ("'", '"'):
        quote = text[j]
        nowdoc = quote == "'"
        j += 1
    if j >= n or text[j] not in PHP_IDENT_START:
        return None
    start_ident = j
    while j < n and text[j] in PHP_IDENT_CHARS:
        j += 1
    ident = text[start_ident:j]
    if quote:
        if j >= n or text[j] != quote:
            return None
        j += 1
    while j < n and text[j] in " \t":
        j += 1
    if j >= n or text[j] != "\n":
        return None
    return ident, nowdoc, j + 1


def _consume_heredoc_body(text, i, ident):
    n = len(text)
    while i < n:
        line_start = i
        line_end = text.find("\n", i)
        if line_end == -1:
            line_end = n
        line = text[line_start:line_end]
        stripped = line.lstrip(" \t")
        if stripped.startswith(ident):
            rest = stripped[len(ident):]
            if rest == "" or (rest[0] not in PHP_IDENT_CHARS):
                return line_start, line_end
        i = line_end + 1
    return n, n


def strip_php(text):
    n = len(text)
    out = []
    i = 0
    in_php = False
    while i < n:
        if not in_php:
            tag = text.find("<?php", i)
            tag_short_echo = text.find("<?=", i)
            tag_short = text.find("<?", i)
            candidates = [t for t in (tag, tag_short_echo, tag_short) if t != -1]
            if not candidates:
                out.append(text[i:])
                break
            next_tag = min(candidates)
            out.append(text[i:next_tag])
            if text[next_tag:next_tag + 5] == "<?php":
                out.append("<?php")
                i = next_tag + 5
            elif text[next_tag:next_tag + 3] == "<?=":
                out.append("<?=")
                i = next_tag + 3
            else:
                out.append("<?")
                i = next_tag + 2
            in_php = True
            continue

        c = text[i]

        if text[i:i + 2] == "?>":
            out.append("?>")
            i += 2
            in_php = False
            continue

        if c in ("'", '"'):
            s, i = _consume_quoted(text, i, c)
            out.append(s)
            continue

        heredoc = _match_heredoc_start(text, i)
        if heredoc is not None:
            ident, _nowdoc, body_start = heredoc
            out.append(text[i:body_start])
            _end_line_start, end_line_end = _consume_heredoc_body(text, body_start, ident)
            out.append(text[body_start:end_line_end])
            i = end_line_end
            continue

        if text[i:i + 2] == "//" or (c == "#" and text[i:i + 2] != "#["):
            nl = text.find("\n", i)
            end_tag = text.find("?>", i)
            if end_tag != -1 and (nl == -1 or end_tag < nl):
                i = end_tag
            elif nl == -1:
                i = n
            else:
                i = nl
            continue

        if text[i:i + 2] == "/*":
            end = text.find("*/", i + 2)
            if end == -1:
                i = n
            else:
                out.append(" ")
                i = end + 2
            continue

        out.append(c)
        i += 1

    return "".join(out)


def _consume_swift_string(text, i):
    n = len(text)
    pound_count = 0
    j = i
    while j < n and text[j] == "#":
        pound_count += 1
        j += 1
    if j >= n or text[j] != '"':
        return None

    triple = text[j:j + 3] == '"""'
    quote_len = 3 if triple else 1
    start = i
    j += quote_len
    closing = '"' * quote_len + "#" * pound_count
    interp_trigger = "\\" + "#" * pound_count + "("

    while j < n:
        if text[j:j + len(closing)] == closing:
            j += len(closing)
            return text[start:j], j
        if text[j:j + len(interp_trigger)] == interp_trigger:
            j += len(interp_trigger)
            depth = 1
            while j < n and depth > 0:
                if text[j] == "(":
                    depth += 1
                    j += 1
                elif text[j] == ")":
                    depth -= 1
                    j += 1
                elif text[j] in ("'", '"'):
                    sub = _consume_swift_string(text, j)
                    if sub is None:
                        j += 1
                    else:
                        _, j = sub
                else:
                    j += 1
            continue
        if text[j] == "\\" and pound_count == 0 and j + 1 < n:
            j += 2
            continue
        if text[j] == "\\" and pound_count > 0:
            if text[j + 1:j + 1 + pound_count] == "#" * pound_count:
                j += 1 + pound_count + 1
                continue
            j += 1
            continue
        if not triple and text[j] == "\n":
            return text[start:j], j
        j += 1
    return text[start:j], j


def strip_swift(text):
    n = len(text)
    out = []
    i = 0
    while i < n:
        c = text[i]

        if c == '"' or (c == "#" and text[i:].lstrip("#")[:1] == '"'):
            result = _consume_swift_string(text, i)
            if result is not None:
                s, i = result
                out.append(s)
                continue

        if text[i:i + 2] == "//":
            nl = text.find("\n", i)
            i = n if nl == -1 else nl
            continue

        if text[i:i + 2] == "/*":
            depth = 1
            j = i + 2
            while j < n and depth > 0:
                if text[j:j + 2] == "/*":
                    depth += 1
                    j += 2
                elif text[j:j + 2] == "*/":
                    depth -= 1
                    j += 2
                else:
                    j += 1
            out.append(" ")
            i = j
            continue

        if c == "'":
            s, i = _consume_quoted(text, i, c)
            out.append(s)
            continue

        out.append(c)
        i += 1

    return "".join(out)


def _consume_rust_char_or_lifetime(text, i):
    n = len(text)
    j = i + 1
    if j < n and text[j] == "\\":
        k = j + 1
        if k < n and text[k] == "u" and k + 1 < n and text[k + 1] == "{":
            end = text.find("}", k + 2)
            k = end + 1 if end != -1 else k + 1
        else:
            k += 1
        if k < n and text[k] == "'":
            return text[i:k + 1], k + 1
        return None
    if j < n and j + 1 < n and text[j] != "'" and text[j + 1] == "'":
        return text[i:j + 2], j + 2
    return None


def _consume_rust_string(text, i):
    n = len(text)
    j = i
    if text[j] in ("b", "B"):
        j += 1
    if j < n and text[j] == "r":
        j += 1
        hashes = 0
        while j < n and text[j] == "#":
            hashes += 1
            j += 1
        if j < n and text[j] == '"':
            j += 1
            closing = '"' + "#" * hashes
            end = text.find(closing, j)
            end_pos = n if end == -1 else end + len(closing)
            return text[i:end_pos], end_pos
        return None
    if j < n and text[j] == '"':
        s, end_pos = _consume_quoted(text, j, '"')
        return text[i:j] + s, end_pos
    return None


def strip_rust(text):
    n = len(text)
    out = []
    i = 0
    while i < n:
        c = text[i]

        if c == '"':
            s, i = _consume_quoted(text, i, '"')
            out.append(s)
            continue

        if c in ("b", "B", "r"):
            result = _consume_rust_string(text, i)
            if result is not None:
                s, i = result
                out.append(s)
                continue

        if c == "'":
            result = _consume_rust_char_or_lifetime(text, i)
            if result is not None:
                s, i = result
                out.append(s)
                continue
            out.append(c)
            i += 1
            continue

        if text[i:i + 2] == "//":
            nl = text.find("\n", i)
            i = n if nl == -1 else nl
            continue

        if text[i:i + 2] == "/*":
            depth = 1
            j = i + 2
            while j < n and depth > 0:
                if text[j:j + 2] == "/*":
                    depth += 1
                    j += 2
                elif text[j:j + 2] == "*/":
                    depth -= 1
                    j += 2
                else:
                    j += 1
            out.append(" ")
            i = j
            continue

        out.append(c)
        i += 1

    return "".join(out)


_JS_REGEX_PRECEDING_KEYWORDS = {
    "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
    "throw", "yield", "case", "do", "else", "extends", "default", "await",
}


def _is_js_regex_context(tail):
    s = tail.rstrip()
    if not s:
        return True
    last = s[-1]
    if last in "([{,;:!&|?=+-*%^~<>\n":
        return True
    if last in ")]}":
        return False
    if last.isalnum() or last in "_$":
        j = len(s)
        k = j
        while k > 0 and (s[k - 1].isalnum() or s[k - 1] in "_$"):
            k -= 1
        return s[k:j] in _JS_REGEX_PRECEDING_KEYWORDS
    return False


def _consume_js_regex(text, i):
    n = len(text)
    j = i + 1
    in_class = False
    closed = False
    while j < n:
        c = text[j]
        if c == "\\" and j + 1 < n:
            j += 2
            continue
        if c == "[":
            in_class = True
            j += 1
            continue
        if c == "]":
            in_class = False
            j += 1
            continue
        if c == "/" and not in_class:
            j += 1
            closed = True
            break
        if c == "\n":
            break
        j += 1
    if not closed:
        return None
    while j < n and text[j].isalpha():
        j += 1
    return text[i:j], j


def _consume_js_template(text, i):
    n = len(text)
    out = ["`"]
    j = i + 1
    while j < n:
        c = text[j]
        if c == "\\" and j + 1 < n:
            out.append(text[j:j + 2])
            j += 2
            continue
        if c == "`":
            out.append("`")
            return "".join(out), j + 1
        if c == "$" and j + 1 < n and text[j + 1] == "{":
            expr_start = j + 2
            depth = 1
            k = expr_start
            while k < n and depth > 0:
                cc = text[k]
                if cc == "{":
                    depth += 1
                    k += 1
                elif cc == "}":
                    depth -= 1
                    k += 1
                elif cc in ('"', "'"):
                    _, k = _consume_quoted(text, k, cc)
                elif cc == "`":
                    _, k = _consume_js_template(text, k)
                elif text[k:k + 2] == "//":
                    nl = text.find("\n", k)
                    k = n if nl == -1 else nl
                elif text[k:k + 2] == "/*":
                    end = text.find("*/", k + 2)
                    k = n if end == -1 else end + 2
                else:
                    k += 1
            expr_end = max(expr_start, k - 1)
            stripped_expr = strip_ts(text[expr_start:expr_end])
            out.append("${" + stripped_expr + "}")
            j = k
            continue
        out.append(c)
        j += 1
    return "".join(out), j


def strip_ts(text):
    n = len(text)
    out = []
    tail = ""
    i = 0
    while i < n:
        c = text[i]

        if c == '"' or c == "'":
            s, i = _consume_quoted(text, i, c)
            out.append(s)
            tail = (tail + s)[-40:]
            continue

        if c == "`":
            s, i = _consume_js_template(text, i)
            out.append(s)
            tail = (tail + s)[-40:]
            continue

        if text[i:i + 2] == "//":
            nl = text.find("\n", i)
            i = n if nl == -1 else nl
            continue

        if text[i:i + 2] == "/*":
            end = text.find("*/", i + 2)
            if end == -1:
                i = n
            else:
                out.append(" ")
                tail = (tail + " ")[-40:]
                i = end + 2
            continue

        if c == "/" and _is_js_regex_context(tail):
            result = _consume_js_regex(text, i)
            if result is not None:
                s, i = result
                out.append(s)
                tail = (tail + s)[-40:]
                continue

        out.append(c)
        tail = (tail + c)[-40:]
        i += 1

    return "".join(out)


STRIPPERS = {
    ".php": strip_php,
    ".swift": strip_swift,
    ".rs": strip_rust,
    ".ts": strip_ts,
    ".tsx": strip_ts,
}


def rstrip_lines(text):
    lines = text.split("\n")
    return "\n".join(line.rstrip(" \t\r") if not line.endswith("\r") else line[:-1].rstrip(" \t") + "\r" for line in lines)


def collapse_blank_lines(text, max_consecutive=1):
    lines = text.split("\n")
    out = []
    blank_run = 0
    for line in lines:
        if line.strip() == "":
            blank_run += 1
            if blank_run <= max_consecutive:
                out.append(line)
        else:
            blank_run = 0
            out.append(line)
    return "\n".join(out)


def iter_target_files(paths, extensions, exclude_dirs):
    for path in paths:
        if os.path.isfile(path):
            if os.path.splitext(path)[1].lower() in extensions:
                yield path
            continue
        for root, dirs, files in os.walk(path):
            dirs[:] = [d for d in dirs if d not in exclude_dirs]
            for name in files:
                if os.path.splitext(name)[1].lower() in extensions:
                    yield os.path.join(root, name)


def process_file(path, dry_run, collapse_blanks):
    with open(path, encoding="utf-8", newline="") as f:
        original = f.read()

    ext = os.path.splitext(path)[1].lower()
    stripper = STRIPPERS[ext]
    stripped = stripper(original)
    stripped = rstrip_lines(stripped)

    if collapse_blanks:
        stripped = collapse_blank_lines(stripped)

    if stripped == original:
        return False

    if not dry_run:
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(stripped)
    return True


def main():
    parser = argparse.ArgumentParser(description="Strip // # /* */ comments from .php and .swift source files.")
    parser.add_argument("paths", nargs="*", default=["."])
    parser.add_argument("--ext", default="php,swift,rs,ts,tsx")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--check", action="store_true", help="Exit 1 if any file would change, without modifying anything.")
    parser.add_argument("--collapse-blank-lines", action="store_true")
    parser.add_argument("--exclude", action="append", default=[])
    args = parser.parse_args()

    extensions = {("." + e.lstrip(".")).lower() for e in args.ext.split(",") if e.strip()}
    unsupported = extensions - set(STRIPPERS)
    if unsupported:
        print(f"No stripper for extensions: {', '.join(sorted(unsupported))}", file=sys.stderr)
        return 2

    exclude_dirs = DEFAULT_EXCLUDE_DIRS | set(args.exclude)
    dry_run = args.dry_run or args.check

    changed = []
    for path in iter_target_files(args.paths, extensions, exclude_dirs):
        try:
            did_change = process_file(path, dry_run=dry_run, collapse_blanks=args.collapse_blank_lines)
        except UnicodeDecodeError:
            print(f"skip (not utf-8): {path}", file=sys.stderr)
            continue
        if did_change:
            changed.append(path)

    for path in changed:
        label = "would change" if dry_run else "stripped"
        print(f"{label}: {path}")

    print(f"\n{len(changed)} file(s) {'would be changed' if dry_run else 'changed'}.")

    if args.check and changed:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
