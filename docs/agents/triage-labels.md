# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the "Label in our tracker" column to match whatever vocabulary you actually use.

## Creation status

These labels do **not** exist yet: there is no GitHub remote to create them on. After
the repository is created (see `docs/agents/issue-tracker.md`), create them with:

```bash
for label in needs-triage needs-info ready-for-agent ready-for-human wontfix; do
  gh label create "$label" --force
done
```

`--force` makes the command idempotent: it updates an existing label instead of failing.
