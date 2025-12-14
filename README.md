# SALOON

```
                    ________________
             ______/                \______
      ______/                              \______
 ____/                                            \____
|    |  ________________________________________  |    |
|    | |                                        | |    |
|    | |   SSS   A   L    OOO   OOO   N   N     | |    |
|    | |   S     A   L    O  O  O  O  NN  N     | |    |
|    | |   SSS   A   L    O  O  O  O  N N N     | |    |
|    | |     S   A   L    O  O  O  O  N  NN     | |    |
|    | |   SSS  AAA  LLL  OOO   OOO   N   N     | |    |
|    | |                                        | |    |
|____| |________________________________________| |____|
      \__________________________________________/
```

---

The Saloon-Obsidian plugin implements `SALOON`, a framework for turning Obsidian Vault Notes into structured AI-enabled Wikis, OWL Ontologies and Anki Flashcards.

SALOON is an acronym which stands for the various parts of the technology stack used.

| Letter | Technology                                             | Purpose                                                       |
|--------|--------------------------------------------------------|---------------------------------------------------------------|
| **S** | [SQLite](https://github.com/sqlite/sqlite)             | Local database for structured data storage                     |
| **A** | [Anki](https://github.com/ankitects/anki)              | Flash card and spaced repetition learning system               |
| **L** | [LangChain](https://github.com/langchain-ai/langchain) | AI tasks, agentic interaction, chat, extraction, summarization |
| **O** | [Obsidian](https://obsidian.md/)                       | Local, encrypted, text-based file store                        |
| **O** | [OWL](https://www.w3.org/OWL/)                         | Ontology system that content follows for knowledge goals       |
| **N** | [Next.js](https://github.com/vercel/next.js/)          | Web app, dynamic UI, optional hosting and distribution         |

## Features

- **Term Extraction**: Extract technical terms, definitions, and context from markdown files using local LLM (Ollama)
- **Approval Workflow**: Review, approve, or reject extracted terms before adding to your glossary
- **Glossary Generation**: Auto-generate wiki-style term pages with definitions, context, and knowledge triples
- **SQLite Database**: All data stored locally in a synced SQLite database

## Prerequisites

- [Ollama](https://ollama.ai/) installed and running locally (or accessible via network)
- An Ollama model pulled (e.g., `ollama pull llama3.1`)

## Installation

1. Open **Settings > Community plugins**
2. Search for "Saloon"
3. Click **Install**, then **Enable**[^1]

[^1]: To sync the database across devices, enable **Settings > Sync > Sync all other types** for `.db` files.

## Usage

On first load, the plugin creates a `_saloon/` folder containing:
- `saloon.md` - Command center with extraction and approval interfaces
- `saloon_db.db` - SQLite database (syncs with your vault)

Open `_saloon/saloon.md` to:
1. Extract terms from the current note or a directory
2. Review and approve pending terms
3. Browse all approved terms

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Glossary folder | Where approved term files are created | `Saloon Glossary` |
| Ollama API URL | Ollama server endpoint | `http://localhost:11434` |

## Data Storage

| Location | Contents |
|----------|----------|
| `_saloon/saloon_db.db` | SQLite database with terms and approval queue |
| `_saloon/saloon.md` | Command center interface |
| `<Glossary folder>/` | Generated term wiki pages |

## Network

This plugin connects to an Ollama server for AI-powered term extraction:
- **Default**: `http://localhost:11434` (configurable in settings)
- **No external services**: All processing is local unless you configure a remote Ollama URL
- **No telemetry**: No data is sent to third parties
