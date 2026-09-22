import argparse
import os
import sys

DEFAULT_EXCLUDE_DIRS = {
    ".git", "node_modules", "target", "dist", "build", ".next", "gen",
    "__pycache__", ".idea", ".vscode", ".build", "DerivedData", ".swiftpm", "Pods",
}

DEFAULT_EXCLUDE_FILES = {
    "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "Cargo.lock",
}

DEFAULT_EXTENSIONS = {
    ".rs", ".ts", ".tsx", ".js", ".jsx", ".css", ".html",
    ".toml", ".json", ".py",
}


def iter_source_files(root, extensions, exclude_dirs, exclude_files):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in exclude_dirs]
        for name in sorted(filenames):
            if name in exclude_files:
                continue
            if os.path.splitext(name)[1].lower() in extensions:
                yield os.path.join(dirpath, name)


def bundle(root, output_path, extensions, exclude_dirs, exclude_files):
    files = sorted(
        iter_source_files(root, extensions, exclude_dirs, exclude_files),
        key=lambda p: os.path.relpath(p, root).replace(os.sep, "/"),
    )

    written = 0
    skipped = []
    with open(output_path, "w", encoding="utf-8", newline="") as out:
        for path in files:
            rel = os.path.relpath(path, root).replace(os.sep, "/")
            try:
                with open(path, encoding="utf-8") as f:
                    content = f.read()
            except UnicodeDecodeError:
                skipped.append(rel)
                continue

            out.write("=" * 80 + "\n")
            out.write(f"FILE: {rel}\n")
            out.write("=" * 80 + "\n")
            out.write(content)
            if not content.endswith("\n"):
                out.write("\n")
            out.write("\n")
            written += 1

    return written, skipped


def main():
    parser = argparse.ArgumentParser(
        description="Bundle all ClipFlow source files into a single text file."
    )
    parser.add_argument("root", nargs="?", default=".")
    parser.add_argument("-o", "--output", default="clipflow_bundle.txt")
    parser.add_argument("--ext", default=",".join(sorted(DEFAULT_EXTENSIONS)))
    parser.add_argument("--exclude", action="append", default=[])
    args = parser.parse_args()

    extensions = {("." + e.lstrip(".")).lower() for e in args.ext.split(",") if e.strip()}
    exclude_dirs = DEFAULT_EXCLUDE_DIRS | set(args.exclude)

    written, skipped = bundle(
        args.root, args.output, extensions, exclude_dirs, DEFAULT_EXCLUDE_FILES
    )

    print(f"Wrote {written} file(s) to {args.output}")
    if skipped:
        print(f"Skipped {len(skipped)} non-UTF-8 file(s):", file=sys.stderr)
        for rel in skipped:
            print(f"  {rel}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
