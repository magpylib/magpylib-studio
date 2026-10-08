# Working in magpylib-studio

Read first, in this order:

1. [docs/architecture.md](docs/architecture.md) — how it works now. The one
   description of the system; when the code and this file disagree, fix one.
2. [docs/roadmap.md](docs/roadmap.md) — what is next, in order, and the
   decisions still waiting on Alex.
3. The plan in flight, if the task touches it: [docs/plans/](docs/plans/).

| Where                                                          | Holds                                                     | Lifetime                                   |
| -------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------ |
| [docs/architecture.md](docs/architecture.md)                   | how it works now: the parts, the document, the protocol   | living; the only description of the system |
| [docs/roadmap.md](docs/roadmap.md)                             | what next, in order; decisions still open                 | living; the only list of next steps        |
| [docs/direction.md](docs/direction.md)                         | why: the positioning and the model                        | stable                                     |
| [docs/decisions.md](docs/decisions.md)                         | one numbered section per decision, with what was rejected | append-only                                |
| [docs/plans/](docs/plans/)                                     | designs in flight                                         | deleted when built                         |
| [docs/guide/](docs/guide/)                                     | how to use it                                             | living                                     |
| [vscode-extension/CHANGELOG.md](vscode-extension/CHANGELOG.md) | what is built, by version                                 | append-only                                |

Then as needed: [docs/direction.md](docs/direction.md) for why the project is
shaped as it is, [docs/decisions.md](docs/decisions.md) for any decision you are
about to revisit (read its record before reopening it), and
[CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and gotchas.

Rules that keep the documents reliable:

- Each kind of fact has one home. Done goes in
  [vscode-extension/CHANGELOG.md](vscode-extension/CHANGELOG.md), next in the
  roadmap, how in architecture, why in a decision record. Do not restate one in
  another.
- A plan is written before the code, in `docs/plans/`, and deleted when built:
  its decisions become records, its as-built facts go into architecture, and git
  keeps the rest.
- A decision's record is never edited. To change one, add a new record that
  supersedes it.
- Code cites decision records by number
  (`docs/decisions.md#0008-units-are-metadata`), never a plan's section.
- Commit and push only when Alex asks.
