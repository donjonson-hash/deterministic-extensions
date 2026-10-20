# Development contract

Read DETERMINISM.md and docs/CORE-API.md before changing behavior.

- Keep the core independent of DOM, browser globals, network, clocks, randomness and locale.
- Preserve raw documents separately from comparison text. Never silently replace invalid UTF-8.
- Validate whole commands before committing state. Do not regenerate stale proposals on click.
- Keep accepted command IDs consumed after Undo. New actions require new IDs.
- Every asynchronous result must be checked against current revision and complete settings context.
- Runtime code must work without an LLM, API key, external request or remote script.
- Changes to semantics require a versioned policy/schema and migration notes.
- Run npm run verify for core/package changes. Run the focused packaged-browser scenario for UI changes.
- A local-page browser pass is not a successful installed-extension check.
- Add meaningful regression cases for changed invariants, not tests that copy implementation internals.
- Never edit existing production repositories as a side effect of maintaining this template.
