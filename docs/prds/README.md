# Product Requirement Documents

One PRD per feature. Each approved PRD gets its own branch, a low-level design
from the LLD agent, and then a series of small PRs into that branch.

## Cluster: BYOK AI Planning — "Your keys, your copilot"

Design spec: [`../superpowers/specs/2026-08-14-byok-ai-planning-cluster-design.md`](../superpowers/specs/2026-08-14-byok-ai-planning-cluster-design.md)

| ID | Feature | Depends on | Size | Status |
| --- | --- | --- | --- | --- |
| [F0](F0-byok-key-vault.md) | BYOK Key Vault & provider abstraction | — | Large | Awaiting approval |
| [F1](F1-ai-trip-copilot.md) | AI Trip Copilot (day-by-day itinerary) | F0 | Medium | Awaiting approval |
| [F2](F2-packing-list-generator.md) | Packing list generator | F0 | Small | Awaiting approval |
| [F3](F3-budget-estimator.md) | Budget estimator & friends split | F0 | Medium | Awaiting approval |
| [F4](F4-natural-language-search.md) | Natural-language trip search | F0 | Medium | Awaiting approval |

F0 blocks everything. F1–F4 are mutually independent once F0 has merged.

## Workflow

```
PRD approved → branch feat/<id>-<slug> → LLD agent produces low-level design
→ coding agent ships micro-task PRs into the feature branch
→ feature branch PR'd into main
```

`main` is the only long-lived branch. Every merge into it is a pull request.
