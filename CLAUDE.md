# eco

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`walle-codes721/eco`, via `gh` CLI); external PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

All five roles use their canonical default strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Note on rule citations in code

Some code comments cite numbered rules (e.g. "CLAUDE.md rule 11", "rule 14"). These refer to a longer local CLAUDE.md (the "Ground rules" from Eco-Plan §3) that has not been pushed yet. Until the two files are merged, treat those citations as pointing to the plan's ground rules: one API client, budget lanes, mock by default, no LLM call for anything local, consent for every voice.
