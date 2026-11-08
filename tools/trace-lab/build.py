import argparse
from pathlib import Path


def main():
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="Build the self-contained AnyPS5 trace analyzer")
    parser.add_argument("--output", type=Path, default=root / "AnyPS5-Profiler.html")
    parser.add_argument("--check", action="store_true", help="Check the generated HTML without writing it")
    args = parser.parse_args()
    page = (root / "index.template.html").read_text(encoding="utf-8")
    for marker, source in (("STYLE", "style.css"), ("MODEL", "model.js"), ("LOADER", "loader.js"), ("APP", "app.js")):
        page = page.replace("__TRACE_LAB_" + marker + "__", (root / source).read_text(encoding="utf-8"))
    if args.check:
        if not args.output.is_file() or args.output.read_text(encoding="utf-8") != page:
            parser.exit(1, "Generated HTML is missing or stale; run build.py.\n")
        print("Generated HTML matches its sources.")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(page, encoding="utf-8", newline="\n")
        print(args.output)


if __name__ == "__main__":
    main()
