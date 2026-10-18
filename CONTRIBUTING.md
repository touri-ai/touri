# Contributing

1. Install Bun 1.4.3+ and Rust 1.90+, then run `bun install`.
2. Make a focused change with tests. All code must be original or compatibly licensed.
3. Before opening a pull request run:

```sh
bun run typecheck
bunx biome check .
TOURI_BROWSER_HEADLESS=1 bun test sidecar/test
(cd ui && bun run test)
(cd src-tauri && cargo test)
```

4. Changes to `packages/contracts/` (types, schema, MCP tools) need a matching migration or schema update.
5. Never commit secrets, personal data or real conversation content; use obviously fake fixtures.

By contributing you agree your work is licensed under Apache-2.0.
