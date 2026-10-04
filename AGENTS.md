# Project guidance

- Use Bun with the existing `bun.lock`; sources are in `src/`, ebook checks in `scripts/`.
- Verify changes with `bun run lint`, `bun run typecheck`, `bun run format:check`, and `bun run test:cache`.
- Ebook builds use `scripts/ci-ebooks.sh` and existing/project-local converters. Preserve authored styling, links and complete content.
- Keep patches focused; reuse existing helpers and avoid extra scripts or reports. Preserve unrelated working-tree changes.
- Never read or package a personal Calibre library in repository/CI builds. Clean only identified task-created temporary files.
