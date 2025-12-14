# Makefile for Saloon Obsidian Plugin

# Configuration - Set your plugin directory here
PLUGIN_DIR ?= $(HOME)/Documents/saloon-career/.obsidian/plugins/saloon

# Files to copy
BUILD_FILES = main.js manifest.json styles.css sql-wasm.wasm

.PHONY: help build install dev clean migrate

help:
	@echo "Saloon Plugin Makefile"
	@echo ""
	@echo "Usage:"
	@echo "  make build           Build the plugin"
	@echo "  make install         Copy plugin files to plugin directory"
	@echo "  make dev             Build and install in one step"
	@echo "  make migrate         Generate new migration from schema changes"
	@echo "  make clean           Remove build artifacts"
	@echo ""
	@echo "Configuration:"
	@echo "  PLUGIN_DIR=$(PLUGIN_DIR)"
	@echo ""
	@echo "Override plugin directory:"
	@echo "  make install PLUGIN_DIR=/path/to/plugin/folder"
	@echo ""
	@echo "Migration workflow:"
	@echo "  1. Edit db/schema.ts with your changes"
	@echo "  2. Run 'make migrate' to generate SQL"
	@echo "  3. Copy generated SQL to db/migrations.ts"
	@echo "  4. Run 'make dev' - migrations auto-apply on plugin load"

build:
	@echo "Building plugin..."
	npm run build

install:
	@echo "Installing plugin to $(PLUGIN_DIR)..."
	@mkdir -p "$(PLUGIN_DIR)"
	@for file in $(BUILD_FILES); do \
		if [ -f "$$file" ]; then \
			echo "  Copying $$file..."; \
			cp "$$file" "$(PLUGIN_DIR)/"; \
		else \
			echo "  Warning: $$file not found, skipping..."; \
		fi \
	done
	@echo "Plugin installed successfully!"

dev: build install
	@echo "Build and install complete!"

migrate:
	@echo "Generating migration from schema changes..."
	npx drizzle-kit generate
	@echo ""
	@echo "Migration generated! Next steps:"
	@echo "  1. Check db/drizzle/ for new .sql file"
	@echo "  2. Add the SQL to db/migrations.ts as MIGRATION_XXXX"
	@echo "  3. Add it to ALL_MIGRATIONS array"
	@echo ""
	@echo "Migrations auto-apply when the plugin loads in Obsidian."

clean:
	@echo "Cleaning build artifacts..."
	@rm -f main.js main.js.map
	@echo "Clean complete!"
