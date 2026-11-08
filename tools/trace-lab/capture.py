import argparse
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile


MANAGED = (
    "APS5_TRACE_FRAMES", "APS5_TRACE_SECONDS", "APS5_TRACE_SUMMARY_EVERY",
    "APS5_TRACE_BENCH", "APS5_TRACE_TRIGGER_FILE", "APS5_TRACE_EVENTS",
    "APS5_TRACE_DIR", "APS5_TRACE_DRAW_PROGRAMS", "APS5_PROFILE_GPU", "APS5_PROFILE_GPU_DRAWS", "APS5_PROFILE_DRAW",
)


def bounded_integer(minimum, maximum):
    def parse(value):
        if not value.isascii() or not value.isdecimal() or not minimum <= int(value) <= maximum:
            raise argparse.ArgumentTypeError(f"Expected an integer from {minimum} through {maximum}")
        return int(value)
    return parse


def child_environment(source, mode, seconds=15, delay=0, events=262144, gpu_details=False, directory=None, trigger=None):
    result = dict(source)
    for name in MANAGED:
        result.pop(name, None)
    if mode != "off":
        result["APS5_TRACE_SECONDS"] = f"{delay}:{seconds}"
        result["APS5_TRACE_EVENTS"] = str(events)
        result["APS5_TRACE_DIR"] = str(directory)
        if gpu_details:
            result["APS5_PROFILE_GPU"] = "1"
        if mode == "manual":
            result["APS5_TRACE_TRIGGER_FILE"] = str(trigger)
    return result


def command_text(arguments):
    if os.name == "nt":
        return "& " + " ".join("'" + str(arg).replace("'", "''") + "'" for arg in arguments)
    return shlex.join(str(arg) for arg in arguments)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Launch AnyPS5 with trace capture off or one bounded capture")
    actions = parser.add_subparsers(dest="action", required=True)
    launch = actions.add_parser("launch", help="Launch a command with isolated trace settings")
    launch.add_argument("--mode", choices=("off", "timed", "manual"), default="off")
    launch.add_argument("--seconds", type=bounded_integer(1, 60), default=15)
    launch.add_argument("--delay", type=bounded_integer(0, 86400), default=0)
    launch.add_argument("--events", type=bounded_integer(1, 4194304), default=262144)
    launch.add_argument("--gpu-details", action="store_true")
    launch.add_argument("--output-dir", type=Path, default=Path("trace-output"))
    launch.add_argument("--cwd", type=Path)
    launch.add_argument("command", nargs=argparse.REMAINDER)
    trigger_parser = actions.add_parser("trigger", help="Create the start file printed by a manual launch")
    trigger_parser.add_argument("path", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.action == "trigger":
            with args.path.open("x", encoding="utf-8") as output:
                output.write("capture\n")
            print("Trigger created. A waiting AnyPS5 run can detect it at a present; this does not confirm that recording started.")
            return 0
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        if not command:
            parser.error("Pass the game executable and arguments after --")
        directory = trigger = None
        if args.mode != "off":
            parent = args.output_dir.resolve()
            if args.mode == "manual" and os.name == "nt" and str(parent).startswith("\\\\"):
                parser.error("Use a local directory for manual capture; network metadata can stall presentation")
            parent.mkdir(parents=True, exist_ok=True)
            directory = Path(tempfile.mkdtemp(prefix="capture-", dir=parent))
            if args.mode == "manual":
                trigger = directory / "start.capture"
        environment = child_environment(os.environ, args.mode, args.seconds, args.delay, args.events, args.gpu_details, directory, trigger)
        if args.mode == "off":
            print("Trace capture is off for this launch. The parent shell environment is unchanged.", flush=True)
        else:
            print(f"One {args.seconds}-second trace; earliest start {args.delay} seconds after the first present. Output: {directory}", flush=True)
            print("The window closes at the first present at least that long after opening. The game continues. A stalled or early-exiting game may not write a trace.", flush=True)
            print("Buffers and GPU timestamp overhead can remain outside the window. Relaunch with --mode off for an untraced session.", flush=True)
            if trigger is not None:
                print("Armed: when the scene is ready, run this command in another terminal:", flush=True)
                print(command_text([sys.executable, Path(__file__).resolve(), "trigger", trigger]), flush=True)
        return subprocess.run(command, env=environment, cwd=args.cwd).returncode
    except OSError as error:
        parser.exit(2, f"Capture launcher: {error}\n")


if __name__ == "__main__":
    raise SystemExit(main())
