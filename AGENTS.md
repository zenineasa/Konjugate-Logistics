# Working in this repository

The Logistics toolbox for Konjugate: a component library (`packages/engine`) and a window add-on (`packages/toolbox`).

Read first:

1. [docs/direction.md](docs/direction.md): where the toolbox is going (a general supply network, milestones A to H) and why.
2. [docs/handover.md](docs/handover.md): the current state, the code map, how scenarios run, and what is easy to get wrong.

Commands: `npm test` (unit), `npm run test:engine` (conservation, needs Konjugate's built engine; `KONJUGATE_ENGINE=export` runs each model as Konjugate's code export writes it, in Python, where there is no engine build for the platform), `npm run test:interaction` (the real app, slow). Konjugate's checkout is expected at `../konjugate` (or `KONJUGATE_DIR`).

Conventions:

- The owner commits; propose a one-sentence commit message describing the change in behaviour.
- No em dashes and no Oxford commas in docs, UI text or comments.
- Every input is labelled with where it came from; results compare choices, never forecast; never tune a scenario to look better; state limits and bugs plainly.
- Every fix comes with a test that would have caught it. Keep `ReadMe.md` and `docs/direction.md` current.
- Fetch from public map servers one region at a time.
- Design the window for newcomers, regular users and power users alike: every action has a button or menu item, a gesture on the map and a key, acts on the whole selection and can be undone, on Windows, Linux and macOS alike, each with its own keys (`lib/platform.mjs`; [docs/interaction.md](docs/interaction.md)). Keep that document's table current when an action changes.
- `npm run test:window` drives the window in a plain browser (no Konjugate build needed); run it with `npm test` on any change to the window.
