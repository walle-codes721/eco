# eco

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`walle-codes721/eco`, via `gh` CLI); external PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

All five roles use their canonical default strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Ground rules

Some code comments cite numbered token rules (e.g. "token rule 3", "token rule 6"). These are defined in `CONTRIBUTING.md` under "Token rules" — one Token Factory client (`src/tf.ts`), mock by default, one translation call per phrase covering every language, nothing local sent to the API, consent for every cloned voice.
