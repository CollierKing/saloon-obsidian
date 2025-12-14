# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-12-14

### Added
- Term extraction from markdown files using local LLM (Ollama)
- Approval workflow for reviewing extracted terms
- SQLite database storage (synced with vault in `_saloon/` folder)
- Auto-generated glossary wiki pages with definitions, context, and knowledge triples
- Command center interface (`_saloon/saloon.md`)
- Configurable Ollama URL and model selection
- Configurable glossary output folder
- Bulk approve/reject for pending terms
- Filter and search for pending approvals
- `saloon-extract` code block for term extraction UI
- `saloon-actions` code block for approval queue
- `saloon-terms` code block for browsing all terms
- `saloon-term-v1` code block for individual term pages

### Changed
- Database location moved to `_saloon/saloon_db.db` for vault sync support

[Unreleased]: https://github.com/CollierKing/saloon-obsidian/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/CollierKing/saloon-obsidian/releases/tag/v1.0.0
