import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent
SCRIPT = ROOT / "capture.py"
SPEC = importlib.util.spec_from_file_location("trace_lab_capture", SCRIPT)
capture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(capture)


class CaptureLaunchTests(unittest.TestCase):
    def run_child(self, options, inherited=None, arguments=None, exit_code=0):
        child = "import json,os,sys;print('CHILD:'+json.dumps({'env':dict(os.environ),'args':sys.argv[1:],'cwd':os.getcwd()}));sys.exit(" + str(exit_code) + ")"
        result = subprocess.run([sys.executable, str(SCRIPT), "launch", *options, "--", sys.executable, "-c", child, *(arguments or [])], env=inherited, capture_output=True, text=True, timeout=15)
        row = next((line[6:] for line in result.stdout.splitlines() if line.startswith("CHILD:")), None)
        return result, json.loads(row) if row else None

    def test_default_off_clears_inherited_capture_and_preserves_other_settings(self):
        environment = dict(os.environ, TRACE_LAB_TEST_KEEP="yes")
        environment.update({name: "inherited" for name in capture.MANAGED})
        result, child = self.run_child([], environment)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(all(name not in child["env"] for name in capture.MANAGED))
        self.assertEqual(child["env"]["TRACE_LAB_TEST_KEEP"], "yes")
        self.assertEqual(environment["APS5_TRACE_SECONDS"], "inherited")

    def test_timed_capture_uses_fifteen_seconds_and_removes_conflicting_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            inherited = dict(os.environ, APS5_TRACE_FRAMES="1:200", APS5_TRACE_SUMMARY_EVERY="5", APS5_TRACE_BENCH="1", APS5_TRACE_TRIGGER_FILE="stale", APS5_PROFILE_GPU="1")
            result, child = self.run_child(["--mode", "timed", "--delay", "30", "--output-dir", directory], inherited)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(child["env"]["APS5_TRACE_SECONDS"], "30:15")
            self.assertEqual(child["env"]["APS5_TRACE_EVENTS"], "262144")
            self.assertTrue(Path(child["env"]["APS5_TRACE_DIR"]).is_dir())
            for name in ("APS5_TRACE_FRAMES", "APS5_TRACE_SUMMARY_EVERY", "APS5_TRACE_BENCH", "APS5_TRACE_TRIGGER_FILE", "APS5_PROFILE_GPU"):
                self.assertNotIn(name, child["env"])

    def test_manual_capture_stays_armed_until_exclusive_trigger_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            result, child = self.run_child(["--mode", "manual", "--output-dir", directory])
            self.assertEqual(result.returncode, 0, result.stderr)
            trigger = Path(child["env"]["APS5_TRACE_TRIGGER_FILE"])
            self.assertEqual(child["env"]["APS5_TRACE_SECONDS"], "0:15")
            self.assertFalse(trigger.exists())
            self.assertIn("Armed:", result.stdout)
            created = subprocess.run([sys.executable, str(SCRIPT), "trigger", str(trigger)], capture_output=True, timeout=15)
            self.assertEqual(created.returncode, 0, created.stderr)
            self.assertTrue(trigger.is_file())
            before = trigger.read_bytes()
            duplicate = subprocess.run([sys.executable, str(SCRIPT), "trigger", str(trigger)], capture_output=True, timeout=15)
            self.assertEqual(duplicate.returncode, 2)
            self.assertEqual(trigger.read_bytes(), before)

    def test_manual_launches_get_unique_trigger_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = []
            for _ in range(2):
                result, child = self.run_child(["--mode", "manual", "--output-dir", directory])
                self.assertEqual(result.returncode, 0, result.stderr)
                paths.append(child["env"]["APS5_TRACE_TRIGGER_FILE"])
            self.assertNotEqual(*paths)

    def test_optional_gpu_details_and_smaller_buffers(self):
        with tempfile.TemporaryDirectory() as directory:
            inherited = dict(os.environ, APS5_PROFILE_GPU_DRAWS="1")
            result, child = self.run_child(["--mode", "timed", "--events", "65536", "--gpu-details", "--output-dir", directory], inherited)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(child["env"]["APS5_PROFILE_GPU"], "1")
            self.assertNotIn("APS5_PROFILE_GPU_DRAWS", child["env"])
            self.assertEqual(child["env"]["APS5_TRACE_EVENTS"], "65536")

    def test_arguments_cwd_exit_status_and_off_output_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "must-not-be-created"
            args = ["with spaces", "a'b", "$(unused)", "--flag=value"]
            result, child = self.run_child(["--mode", "off", "--cwd", directory, "--output-dir", str(output)], arguments=args, exit_code=7)
            self.assertEqual(result.returncode, 7)
            self.assertEqual(child["args"], args)
            self.assertEqual(Path(child["cwd"]), Path(directory))
            self.assertFalse(output.exists())

    def test_invalid_duration_does_not_launch_child(self):
        for value in ("0", "-1", "61", "1.5", "NaN", "１５"):
            with self.subTest(value=value):
                result, child = self.run_child(["--seconds", value])
                self.assertEqual(result.returncode, 2)
                self.assertIsNone(child)

    def test_parent_environment_is_not_mutated(self):
        source = {name: "old" for name in capture.MANAGED}
        snapshot = dict(source)
        result = capture.child_environment(source, "manual", directory="out", trigger="start")
        self.assertEqual(source, snapshot)
        self.assertEqual(result["APS5_TRACE_SECONDS"], "0:15")
        self.assertNotIn("APS5_TRACE_SUMMARY_EVERY", result)


if __name__ == "__main__":
    unittest.main()
