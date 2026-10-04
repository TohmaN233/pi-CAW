# Pi Workbench frontend

The graph editor, graph adapter, inspectors, Pack panels, Skill import and authoring review UI, package installer, and visual styles originate from the pinned Codex Agents Workflow source recorded in `docs/upstream.json`. The source repository is read-only during migration. React and XYFlow remain the rendering and graph editing stack.

`pi-client.ts` is the only browser transport. It sends authenticated `POST /api` requests containing `{ operation, args }` and requires a `{ result }` response. Loopback credentials are read from the URL fragment, removed from the visible URL, and retained only in tab memory. HTTP errors and malformed envelopes fail visibly. Refreshing the entire browser tab requires reopening the Workbench from Pi.

Pi owns authentication, providers, available models, and session execution. `pi-settings.tsx` uses the current session catalog and persists only explicit child bindings. Model and thinking selectors retain empty values until selected; an unavailable or changed binding is shown for explicit repair. Main is the current Pi chat and has no independent model or thinking field. Source Role prompts, trigger instructions, tags, and provenance survive settings edits.

`run-panel.tsx` reads the pinned graph and journal, then exposes human approval, exact final-proposal acceptance, explicit retry/recovery, child Runs, dependency rechecking, and parallel integration. Browser actions name the exact run, node, attempt, proposal, or patch; the server resolves and validates its native Pi authority. Codex App Server login and connector transport controls were replaced by Pi session controls. Read-only graph previews use the same Canvas without edit handlers.

The Workbench includes source-brief creation, Role instruction compilation and copying, Role assignment, Skill conversion with independent review and bounded repair, resource/version editing, package installation/export, and reviewed cache cleanup. Cache deletion binds to the preview's `plan_hash`; a changed plan requires another preview.

Run `npm run build:web` after frontend edits. `npm run check:web` typechecks TypeScript and verifies committed browser assets against a fresh deterministic build. Bundled dependency licenses are emitted alongside the assets. Offline frontend tests exercise lossless graph edits, publication/launch separation, continuation-source selection, refresh ordering, rendered inspector/settings/brief/Role forms, and authenticated transport failures. These checks do not constitute browser screenshot or paid model execution evidence.
