# How changes are made

Three agents live in `.claude/agents/`: **auditor** (read-only review), **builder** (one approved change, on a branch), **verifier** (independent check of that branch). Agents never merge, push or deploy. Kyle does.

1. **Audit:** "Use the auditor agent. Mode: code-only." (or `full` with Sheet exports in `agent-data/`). Result is saved as `docs/01-audit.md`.
2. **Gate:** Kyle and the business owner read the audit and pick 1-2 changes into `docs/02-approved.md`, each with a one-line requirement.
3. **Build:** "Use the builder agent on #1 in docs/02-approved.md."
4. **Verify:** "Use the verifier agent on branch agent/<name> with the same requirement." Merge only on PASS.

`docs/01-audit.md`, `docs/02-approved.md` and `agent-data/` are deliberately **not** committed: the repo is public and they describe weaknesses or contain business data. Their master copies are kept in the private claude.ai Project.
