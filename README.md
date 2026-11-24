# Tessera

Agent-first futures trading workspace: a Tauri 2 desktop shell and React UI over a local Rust
runtime that owns all state, tools, permissions and agent sessions. Bring your own AI (your
Codex or Claude Code subscription CLI, or any MCP client) and your own data: market data comes from your
Rithmic login, levels from any API you add, from its docs, with the analyst.

```sh
bun install
bun run dev     # http://localhost:5173, with your Rithmic login from ~/.config/tessera/credentials.env
bun run check   # everything a pull request must pass
```

- Developing: [`docs/dev.md`](docs/dev.md) (prerequisites, commands, ports, auth, troubleshooting).
- Product, users and principles: [`PRODUCT.md`](PRODUCT.md).
- Architecture: [`docs/architecture.md`](docs/architecture.md).
- Agents working in this repo: [`AGENTS.md`](AGENTS.md).

Status: alpha for futures traders on macOS, Windows and Linux.

## License

Apache License 2.0: see [`LICENSE`](LICENSE). Third-party marks, fonts and voice clips keep their own terms, listed in
[`NOTICE`](NOTICE).
