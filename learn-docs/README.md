# Angular Source Code Learning

> Learn more about Angular to benefit my career, solve issues with a clear mind, and practice learning skills when meeting new things.

## 📖 Document Index

### General Collections (`learn-docs/collections/`)

| # | Document | Title |
|---|----------|-------|
| 000 | [000-roadmap.md](./collections/000-roadmap.md) | Roadmap |
| 001 | [001-brazel.md](./collections/001-brazel.md) | Brazel |

### core/primitives/signals (`packages/core/primitives/signals/src/docs/`)

| Document | Title |
|----------|-------|
| [graph.learn.md](../packages/core/primitives/signals/src/docs/graph.learn.md) | Graph |
| [how-to-operate-dom-in-signal-based-angular.md](../packages/core/primitives/signals/src/docs/how-to-operate-dom-in-signal-based-angular.md) | How To Operate Dom In Signal Based Angular |
| [signal.learn.md](../packages/core/primitives/signals/src/docs/signal.learn.md) | Signal |
| [when-effects-run.md](../packages/core/primitives/signals/src/docs/when-effects-run.md) | When Effects Run |

## 📝 Conventions

- **Source-adjacent docs**: Notes tightly coupled to specific source code go in `src/docs/` next to the code (e.g., `packages/core/primitives/signals/src/docs/`)
- **General learning notes**: Cross-cutting or general notes go in `learn-docs/collections/`
- **Naming**: Use `.learn.md` suffix for learning documents, or place them in a `docs/` folder
- **Format**: Each document starts with metadata (date, topic, related source paths), followed by Q&A or "Question → Analysis → Conclusion" structure
- **Conflict safety**: Only add new files — never modify official Angular files. This ensures zero conflicts when syncing upstream.

## 🔄 Auto-generate this index

```bash
node learn-docs/scripts/generate-index.mjs
```

This script scans for all learning documents in `learn-docs/collections/` and `**/src/docs/` directories, then regenerates this README.
