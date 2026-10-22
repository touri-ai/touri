# Menu screenshot references

Linux menu references use the browser and font fallback set from the immutable image
specified in `.github/workflows/menu-snapshots.yml` and the `browser-e2e` job in
`.github/workflows/ci.yml`. Keep both image digests aligned with the locked Playwright
version. A host's native font fallback is not the reference environment.

The project selection checkmark is a text glyph. Different Linux font sets can render
it differently even when menu geometry and the rest of the text are identical. Keep
Linux screenshot comparisons at zero differing pixels; do not compensate with a
pixel allowance or change product CSS to match an unrelated host's fonts.

To regenerate references, run the Menu snapshots workflow manually with
`update_snapshots` enabled. Download its `menu-snapshots` artifact, inspect the old
reference, new reference and difference in both themes, then commit only intentional
reference changes. Run the normal comparison on that commit and attach the inspected
before/after images to the PR. Ordinary PR and main runs only compare references.

The artifact includes font metadata for the selected project checkmark and synthetic
menu captures. Browser shard failures also retain PNGs and error context for seven days.
