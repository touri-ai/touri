# Rust dependency licenses

The desktop crate is Apache-2.0. `src-tauri/deny.toml` checks its default-feature
dependency graph, including build dependencies, for `aarch64-apple-darwin`, the
shipping target and Rust CI runner. Add the Linux target when the desktop port
lands. Run `cargo deny check` from `src-tauri` with cargo-deny 0.20.2.

The allow-list selects Apache-2.0, MIT, BSD-3-Clause and ISC from the resolved
tree. Unicode-3.0 covers ICU and Unicode data crates; Zlib covers foldhash and
zlib-rs. Retain dependency copyright and license notices in distributions.
Unlisted licenses fail the check, including licenses on build dependencies.

Five transitive dependencies require MPL-2.0. They have per-crate exceptions,
following the existing MPL distribution precedent in `THIRD_PARTY_NOTICES`.
Their source remains MPL-2.0; touri's own source remains Apache-2.0. Retain their
notices and include the MPL text (`novnc-MPL-2.0.txt` in this directory) and
access to the corresponding source with distributed binaries. The current
unmodified crate sources are:

| Crate | Version | Corresponding source |
| --- | --- | --- |
| cssparser | 0.37.0 | <https://crates.io/api/v1/crates/cssparser/0.37.0/download> |
| cssparser-macros | 0.7.1 | <https://crates.io/api/v1/crates/cssparser-macros/0.7.1/download> |
| dtoa-short | 0.3.5 | <https://crates.io/api/v1/crates/dtoa-short/0.3.5/download> |
| option-ext | 0.2.0 | <https://crates.io/api/v1/crates/option-ext/0.2.0/download> |
| selectors | 0.38.0 | <https://crates.io/api/v1/crates/selectors/0.38.0/download> |

Review these source links when updating the lockfile. If these crates are
modified, also make the modified covered source available under MPL-2.0.

Known vulnerability advisories fail the check. Any unavoidable advisory ignore
must identify the advisory and include a reason and upstream link in
`deny.toml`. Duplicate versions warn; registry and git sources outside crates.io
fail. The policy regression test runs in Rust CI and can also be run with
`python3 scripts/test-rust-policy.py` from the repository root.
