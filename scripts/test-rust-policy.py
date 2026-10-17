"""Regression checks for the Rust CI wiring and its real license gate.

Run with python3 scripts/test-rust-policy.py after installing cargo-deny.
Only the Python standard library and Cargo tools are required.
"""

import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / "src-tauri" / "deny.toml"


class RustPolicyTests(unittest.TestCase):
    def test_ci_installs_pinned_tool_and_runs_tests_before_audit(self):
        workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
        rust = re.split(r"(?m)^  [\w-]+:", workflow.split("  rust:\n", 1)[1])[0]
        install = re.search(
            r"taiki-e/install-action@(?:[0-9a-f]{40}|v\d+\.\d+\.\d+)\b", rust
        )
        self.assertIsNotNone(install, "install cargo-deny with a pinned action")
        self.assertRegex(rust, r"tool: cargo-deny@\d+\.\d+\.\d+\b")
        audit = rust.index("run: cargo deny check")
        self.assertLess(install.start(), audit)
        self.assertLess(rust.index("run: cargo test"), audit)
        self.assertNotIn("continue-on-error: true", rust)

    def check_license(self, license_name):
        with tempfile.TemporaryDirectory(prefix="touri-rust-policy-") as directory:
            fixture = Path(directory)
            (fixture / "Cargo.toml").write_text(
                '[package]\nname = "policy-fixture"\nversion = "0.1.0"\n'
                f'license = "{license_name}"\n'
            )
            (fixture / "src").mkdir()
            (fixture / "src" / "lib.rs").write_text("")
            return subprocess.run(
                [
                    "cargo", "deny", "--offline", "--manifest-path",
                    str(fixture / "Cargo.toml"), "--config",
                    str(POLICY), "check", "licenses",
                ],
                capture_output=True,
                text=True,
                check=False,
            )

    def test_permissive_license_passes(self):
        result = self.check_license("MIT")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_unapproved_copyleft_license_fails(self):
        result = self.check_license("GPL-3.0-only")
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertIn("GPL-3.0-only", result.stderr)


if __name__ == "__main__":
    unittest.main()
