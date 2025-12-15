/* MARK: - Imports */
import { App, Component, MarkdownRenderer, Notice, Plugin, PluginSettingTab, requestUrl, Setting, TFile } from 'obsidian';
import { DrizzleDatabase, approvalActions, terms, settings } from './db';
import { eq } from 'drizzle-orm';
import { extractTermsFromMarkdown, Term, deduplicateTerms, chunkText, ProgressInfo } from './corpus';
import matter from 'gray-matter';

/* MARK: - Interfaces and Settings */

interface SaloonPluginSettings {
	glossaryFolder: string;
	ollamaUrl: string;
}

const DEFAULT_SETTINGS: SaloonPluginSettings = {
	glossaryFolder: 'Saloon Glossary',
	ollamaUrl: 'http://localhost:11434'
}

// MARK: Constants

const DATABASE_FILENAME = 'saloon_db.db';
const SALOON_FOLDER = '_saloon';
const COMMAND_CENTER_FILENAME = `${SALOON_FOLDER}/saloon.md`;
const COMMAND_CENTER_CONTENT = `# Saloon Command Center

Welcome to the Saloon Term Extraction Command Center! Use this interface to extract technical terms from your markdown files using AI-powered analysis.

## Term Extraction

Extract terms, then approve or reject each one individually.

\`\`\`saloon-extract
\`\`\`

## Approved Terms

\`\`\`saloon-terms
\`\`\`
`;

/* MARK: - Utility Functions */

function renderAsMarkdownTable(results: Record<string, unknown>[]): string {
	if (results.length === 0) {
		return 'No results found.';
	}

	const keys = Object.keys(results[0]);

	// Create header row
	const header = '| ' + keys.join(' | ') + ' |';
	const separator = '| ' + keys.map(() => '---').join(' | ') + ' |';

	// Create data rows
	const rows = results.map(row => {
		const values = keys.map(key => {
			const value = row[key];
			if (value === null || value === undefined) return '';
			// Handle objects and arrays by JSON stringifying them
			if (typeof value === 'object') return JSON.stringify(value);
			// For primitives (string, number, boolean), convert to string
			if (typeof value === 'string') return value;
			if (typeof value === 'number' || typeof value === 'boolean') return value.toString();
			return '';
		});
		return '| ' + values.join(' | ') + ' |';
	});

	return [header, separator, ...rows].join('\n');
}

interface KnowledgeTriple {
	subject: string;
	predicate: string;
	target: string;
}

/**
 * Generate basic knowledge triples from term definition
 */
function generateKnowledgeTriples(term: string, definition: string): KnowledgeTriple[] {
	const triples: KnowledgeTriple[] = [];

	if (!definition) return triples;

	// Try to extract "is a" relationship from definition
	// Pattern: "Term is a/an <type>" or "A <type> that..."
	const isAMatch = definition.match(/^(?:An?\s+)?(\w+(?:\s+\w+)?)\s+(?:that|which|is)/i);
	if (isAMatch) {
		triples.push({
			subject: term,
			predicate: 'is a',
			target: isAMatch[1].toLowerCase()
		});
	}

	// Extract "used for" or "used to" relationships
	const usedForMatch = definition.match(/used\s+(?:for|to)\s+([^.,]+)/i);
	if (usedForMatch) {
		triples.push({
			subject: term,
			predicate: 'used for',
			target: usedForMatch[1].trim()
		});
	}

	// Extract "part of" relationships
	const partOfMatch = definition.match(/part\s+of\s+(?:a\s+|an\s+|the\s+)?([^.,]+)/i);
	if (partOfMatch) {
		triples.push({
			subject: term,
			predicate: 'part of',
			target: partOfMatch[1].trim()
		});
	}

	// Extract "related to" from context mentions
	const relatedMatch = definition.match(/(?:related\s+to|associated\s+with|works\s+with)\s+([^.,]+)/i);
	if (relatedMatch) {
		triples.push({
			subject: term,
			predicate: 'relates to',
			target: relatedMatch[1].trim()
		});
	}

	// If no triples found, create a default one
	if (triples.length === 0) {
		// Extract first noun phrase as a fallback
		const words = definition.split(/\s+/).slice(0, 5);
		if (words.length > 0) {
			triples.push({
				subject: term,
				predicate: 'defined as',
				target: words.join(' ').replace(/[.,;]$/, '')
			});
		}
	}

	return triples;
}

interface TermFileData {
	termId: string;
	term: string;
	definition?: string;
	context?: string;
	sources: string[];  // Array of source file paths
	createdAt: string;
}

/**
 * Generate markdown content for a term file
 */
function generateTermFileContent(data: TermFileData): string {
	const triples = generateKnowledgeTriples(data.term, data.definition || '');

	// Generate source links as Obsidian wiki-links (used for future template expansion)
	// eslint-disable-next-line @typescript-eslint/no-unused-vars -- prepared for future template expansion
	const _sourceLinks = data.sources
		.map(src => {
			// Extract filename without extension for wiki-link
			const match = src.match(/([^/]+?)(?:\.[^.]+)?$/);
			return match ? `[[${match[1]}]]` : `[[${src}]]`;
		})
		.join(', ');

	// Build frontmatter
	const frontmatter = [
		'---',
		`termId: ${data.termId}`,
		`term: "${data.term.replace(/"/g, '\\"')}"`,
		`createdAt: ${data.createdAt}`,
		`updatedAt: ${data.createdAt}`,
		'---'
	].join('\n');

	// Build knowledge triples table (used for future template expansion)
	// eslint-disable-next-line @typescript-eslint/no-unused-vars -- prepared for future template expansion
	const _triplesTable = triples.length > 0
		? [
			'| Subject | Predicate | Target |',
			'|---------|-----------|--------|',
			...triples.map(t => `| ${t.subject} | ${t.predicate} | ${t.target} |`)
		].join('\n')
		: [
			'| Subject | Predicate | Target |',
			'|---------|-----------|--------|',
			`| ${data.term} | | |`
		].join('\n');

	// Build the full content - only frontmatter and code block
	// The code block renders everything from the database
	const content = [
		frontmatter,
		'',
		'```saloon-term-v1',
		'```'
	].join('\n');

	return content;
}

/**
 * Sanitize term name for use as filename
 */
function sanitizeFilename(term: string): string {
	return term
		.replace(/[/\\?%*:|"<>]/g, '-')  // Replace invalid chars
		.replace(/\s+/g, ' ')             // Normalize whitespace
		.trim();
}

/* MARK: - Main Plugin */
export default class SaloonPlugin extends Plugin {
	settings: SaloonPluginSettings;
	dbService: DrizzleDatabase;
	lastDbModTime: number = 0;
	databasePath: string = '';
	wasmPath: string = '';

	// MARK: Plugin Lifecycle

	async onload() {
		await this.loadSettings();

		/* MARK: Database Initialization */
		try {
			const adapter = this.app.vault.adapter;

			// Create _saloon folder if it doesn't exist (for database and command center)
			const folderExists = await adapter.exists(SALOON_FOLDER);
			if (!folderExists) {
				await this.app.vault.createFolder(SALOON_FOLDER);
			}

			// Load WASM file from plugin directory
			// @ts-ignore - manifest is available on Plugin
			const pluginDir = this.manifest.dir;
			this.wasmPath = `${pluginDir}/sql-wasm.wasm`;
			// Database stored in _saloon folder (synced with vault)
			this.databasePath = `${SALOON_FOLDER}/${DATABASE_FILENAME}`;

			const wasmBinary = await adapter.readBinary(this.wasmPath);

			// Initialize Drizzle database
			this.dbService = new DrizzleDatabase();
			await this.dbService.initialize(wasmBinary, this.databasePath, this.app.vault);

			// Store initial modification time
			const stat = await adapter.stat(this.databasePath);
			if (stat) {
				this.lastDbModTime = stat.mtime;
			}

			// Create Command Center file if it doesn't exist
			const commandCenterExists = await adapter.exists(COMMAND_CENTER_FILENAME);
			if (!commandCenterExists) {
				await this.app.vault.create(COMMAND_CENTER_FILENAME, COMMAND_CENTER_CONTENT);
				new Notice('Saloon command center created in _saloon folder');
			}
		} catch (error) {
			console.error('Failed to initialize Saloon plugin:', error);
			new Notice('Failed to initialize Saloon plugin. Check console for errors.');
			return;
		}

		/* MARK: Code Block Processors */

		// MARK: saloon-actions Block
		this.registerMarkdownCodeBlockProcessor('saloon-actions', async (_source, el, _ctx) => {
			try {
				// Check and reload database if file changed
				await this.checkAndReloadDatabase();

				if (!this.dbService || !this.dbService.db) {
					el.createEl('div', { text: 'Error: database not loaded' });
					return;
				}

				const db = this.dbService.db;

				// Query pending actions with create_term type
				const pendingActions = await db
					.select()
					.from(approvalActions)
					.where(eq(approvalActions.status, 'pending'));

				// Create container
				const container = el.createDiv({ cls: 'saloon-actions-container' });
				container.createEl('h3', { text: 'Pending approvals', cls: 'saloon-actions-title' });

				if (pendingActions.length === 0) {
					container.createEl('p', { text: 'No pending actions.', cls: 'saloon-empty-message' });
					return;
				}

				container.createEl('p', {
					text: `${pendingActions.length} term${pendingActions.length === 1 ? '' : 's'} awaiting approval`,
					cls: 'saloon-actions-count'
				});

				// Scrollable list
				const actionsList = container.createDiv({ cls: 'saloon-actions-list' });

				for (const action of pendingActions) {
					// Parse term details
					let termDetails: { term?: string; definition?: string; context?: string; source?: string } = {};
					try {
						if (action.termDetails) {
							termDetails = typeof action.termDetails === 'string'
								? JSON.parse(action.termDetails)
								: action.termDetails;
						}
					} catch (e) {
						console.error('Failed to parse term details:', e);
					}

					const actionCard = actionsList.createDiv({ cls: 'saloon-action-card' });

					// Term header
					const termHeader = actionCard.createDiv({ cls: 'saloon-action-header' });
					termHeader.createEl('strong', { text: termDetails.term || 'Unknown Term' });
					termHeader.createEl('span', {
						text: action.actionType === 'create_term' ? 'New term' : action.actionType,
						cls: 'saloon-action-badge'
					});

					// Term details
					if (termDetails.definition) {
						actionCard.createEl('p', {
							text: termDetails.definition,
							cls: 'saloon-action-definition'
						});
					}

					if (termDetails.context) {
						actionCard.createEl('em', {
							text: `Context: ${termDetails.context}`,
							cls: 'saloon-action-context'
						});
					}

					if (termDetails.source) {
						actionCard.createEl('small', {
							text: `Source: ${termDetails.source}`,
							cls: 'saloon-action-source'
						});
					}

					// Action buttons
					const buttonRow = actionCard.createDiv({ cls: 'saloon-action-buttons' });

					const approveBtn = buttonRow.createEl('button', {
						text: 'Approve',
						cls: 'saloon-approve-button'
					});

					const rejectBtn = buttonRow.createEl('button', {
						text: 'Reject',
						cls: 'saloon-reject-button'
					});

					approveBtn.addEventListener('click', () => {
						void (async () => {
							try {
								const now = new Date().toISOString();
								// Update status to approved
								await db.update(approvalActions)
									.set({ status: 'approved', updatedAt: now })
									.where(eq(approvalActions.id, action.id));

								// Create the actual term
								const triples = generateKnowledgeTriples(termDetails.term || '', termDetails.definition || '');
								// Build context array with text and source
								const contextArray = termDetails.context ? [{
									text: termDetails.context,
									source: termDetails.source || ''
								}] : [];
								await db.insert(terms).values({
									termId: action.targetTermId || crypto.randomUUID(),
									term: termDetails.term || '',
									definition: termDetails.definition || '',
									context: JSON.stringify(contextArray),
									knowledgeTriples: JSON.stringify(triples),
									createdAt: now,
									updatedAt: now
								});

								await this.dbService.saveDatabase(this.databasePath, this.app.vault);
								actionCard.remove();
								new Notice(`Approved: ${termDetails.term}`);
							} catch (error) {
								console.error('Failed to approve:', error);
								new Notice('Failed to approve term.');
							}
						})();
					});

					rejectBtn.addEventListener('click', () => {
						void (async () => {
							try {
								const now = new Date().toISOString();
								await db.update(approvalActions)
									.set({ status: 'rejected', updatedAt: now })
									.where(eq(approvalActions.id, action.id));

								await this.dbService.saveDatabase(this.databasePath, this.app.vault);
								actionCard.remove();
								new Notice(`Rejected: ${termDetails.term}`);
							} catch (error) {
								console.error('Failed to reject:', error);
								new Notice('Failed to reject term.');
							}
						})();
					});
				}
			} catch (error) {
				console.error('saloon-actions error:', error);
				el.createEl('div', { text: `Error: ${error.message}` });
			}
		});

		// MARK: saloon-terms Block
		this.registerMarkdownCodeBlockProcessor('saloon-terms', async (source, el, ctx) => {
			try {
				// Check and reload database if file changed
				await this.checkAndReloadDatabase();

				if (!this.dbService || !this.dbService.db) {
					el.createEl('div', { text: 'Error: database not loaded' });
					return;
				}

				const db = this.dbService.db;

				// Query all terms
				const allTerms = await db
					.select()
					.from(terms);

				const markdownTable = renderAsMarkdownTable(allTerms);
				const renderComponent = new Component();
				renderComponent.load();
				await MarkdownRenderer.render(this.app, markdownTable, el, ctx.sourcePath, renderComponent);
			} catch (error) {
				console.error('saloon-terms error:', error);
				el.createEl('div', { text: `Error: ${error.message}` });
			}
		});

		// MARK: saloon-extract Block
		this.registerMarkdownCodeBlockProcessor('saloon-extract', async (source, el, ctx) => {
			try {
				// Check database is ready
				await this.checkAndReloadDatabase();
				if (!this.dbService || !this.dbService.db) {
					el.createEl('div', { text: 'Error: database not loaded' });
					return;
				}

				const db = this.dbService.db;

				// Load saved settings
				const savedSettings = await db.select().from(settings);
				const settingsMap = new Map(savedSettings.map(s => [s.key, s.value]));

				const savedModel = settingsMap.get('extract.model') || 'gpt-oss:20b';
				const savedSourcePath = settingsMap.get('extract.sourcePath') || '';
				const savedChunkSize = parseInt(settingsMap.get('extract.chunkSize') || '4000', 10);

				// Helper to save a setting
				const saveSetting = async (key: string, value: string) => {
					const now = new Date().toISOString();
					await db.insert(settings)
						.values({ key, value, updatedAt: now })
						.onConflictDoUpdate({
							target: settings.key,
							set: { value, updatedAt: now }
						});
					// Persist to disk
					await this.dbService.saveDatabase(this.databasePath, this.app.vault);
				};

				// Create container
				const container = el.createDiv({ cls: 'saloon-extract-container' });

				// Title
				container.createEl('h3', { text: 'Saloon term extraction', cls: 'saloon-extract-title' });

				// Config section
				const configSection = container.createDiv({ cls: 'saloon-config-section' });

				// Get Ollama URL from plugin settings (configured in Settings tab)
				const ollamaUrl = this.settings.ollamaUrl || 'http://localhost:11434';

				// Model selection (dropdown)
				const modelGroup = configSection.createDiv({ cls: 'saloon-input-group' });
				modelGroup.createEl('label', { text: 'Model:', cls: 'saloon-label' });
				const modelSelect = modelGroup.createEl('select', {
					cls: 'saloon-input saloon-select'
				});
				const modelStatus = modelGroup.createEl('small', {
					text: 'Enter Ollama URL and click away to load models',
					cls: 'saloon-hint'
				});

				// Helper to fetch and populate models from Ollama
				const fetchOllamaModels = async (baseUrl: string) => {
					modelStatus.textContent = 'Loading models...';
					modelStatus.removeClass('saloon-status-error');
					modelSelect.empty();
					modelSelect.disabled = false;

					try {
						const response = await requestUrl({
							url: `${baseUrl}/api/tags`,
							method: 'GET',
						});

						const data = response.json;
						const models: { name: string }[] = data.models || [];

						if (models.length === 0) {
							modelSelect.createEl('option', { text: 'No models found', value: '' });
							modelStatus.textContent = 'No models installed. Run: ollama pull <model>';
							return;
						}

						// Populate dropdown
						models.forEach(model => {
							const option = modelSelect.createEl('option', {
								text: model.name,
								value: model.name
							});
							// Select saved model if it matches
							if (model.name === savedModel) {
								option.selected = true;
							}
						});

						// If saved model wasn't in the list, add it as first option
						if (savedModel && !models.some(m => m.name === savedModel)) {
							const savedOption = modelSelect.createEl('option', {
								text: `${savedModel} (not found)`,
								value: savedModel
							});
							modelSelect.insertBefore(savedOption, modelSelect.firstChild);
							savedOption.selected = true;
						}

						modelStatus.textContent = `${models.length} model${models.length === 1 ? '' : 's'} available`;
					} catch (error) {
						console.error('Failed to fetch Ollama models:', error);
						// Empty dropdown on connection failure
						modelSelect.createEl('option', { text: 'No connection', value: '' });
						modelSelect.disabled = true;
						modelStatus.textContent = `Could not connect to ${baseUrl}`;
						modelStatus.addClass('saloon-status-error');
					}
				};

				// Save model selection on change
				modelSelect.addEventListener('change', () => void saveSetting('extract.model', modelSelect.value));

				// Initial model fetch using plugin settings URL
				await fetchOllamaModels(ollamaUrl);

				// Source directory input
				const sourceGroup = configSection.createDiv({ cls: 'saloon-input-group' });
				sourceGroup.createEl('label', { text: 'Source directory (optional):', cls: 'saloon-label' });
				const sourceInput = sourceGroup.createEl('input', {
					type: 'text',
					placeholder: 'Leave empty to extract from current file',
					cls: 'saloon-input',
					value: savedSourcePath
				});
				sourceInput.addEventListener('blur', () => void saveSetting('extract.sourcePath', sourceInput.value));
				sourceGroup.createEl('small', {
					text: 'Enter a vault-relative path (e.g., "notes") or absolute path. Leave empty for current file only',
					cls: 'saloon-hint'
				});

				// Chunk size slider
				const chunkGroup = configSection.createDiv({ cls: 'saloon-input-group' });
				chunkGroup.createEl('label', { text: 'Chunk size (characters):', cls: 'saloon-label' });
				const chunkRow = chunkGroup.createDiv({ cls: 'saloon-slider-row' });
				const chunkSlider = chunkRow.createEl('input', {
					type: 'range',
					cls: 'saloon-slider'
				});
				chunkSlider.min = '1000';
				chunkSlider.max = '8000';
				chunkSlider.step = '500';
				chunkSlider.value = String(savedChunkSize);

				const chunkValue = chunkRow.createEl('span', {
					text: String(savedChunkSize),
					cls: 'saloon-slider-value'
				});

				chunkSlider.addEventListener('input', () => {
					chunkValue.textContent = chunkSlider.value;
				});
				chunkSlider.addEventListener('change', () => {
					void saveSetting('extract.chunkSize', chunkSlider.value);
				});

				chunkGroup.createEl('small', {
					text: 'Smaller chunks = more API calls but better for detailed extraction. Default: 4000',
					cls: 'saloon-hint'
				});

				// Button section
				const buttonSection = container.createDiv({ cls: 'saloon-button-section' });
				const button = buttonSection.createEl('button', {
					text: 'Extract terms',
					cls: 'saloon-extract-button'
				});

				// Progress bar (hidden initially)
				const progressContainer = container.createDiv({ cls: 'saloon-progress-container saloon-hidden' });
				const progressBar = progressContainer.createDiv({ cls: 'saloon-progress-bar' });
				const progressFill = progressBar.createDiv({ cls: 'saloon-progress-fill' });
				const progressText = progressContainer.createDiv({ cls: 'saloon-progress-text' });

				// Results container
				const resultsContainer = container.createDiv({ cls: 'saloon-extract-results' });

				// Pending items container
				const pendingContainer = container.createDiv({ cls: 'saloon-pending-section' });

				// Function to load and render pending items
				const loadPendingItems = async () => {
					pendingContainer.empty();

					try {
						const pendingItems = await db.select()
							.from(approvalActions)
							.where(eq(approvalActions.status, 'pending'));

						if (pendingItems.length === 0) {
							pendingContainer.addClass('saloon-hidden');
							return;
						}

						pendingContainer.removeClass('saloon-hidden');

						// Track selected items
						const selectedIds = new Set<string>();
						type PendingItem = typeof pendingItems[0];
						const itemElements: { el: HTMLElement; item: PendingItem; termName: string; source: string }[] = [];

						// Header with count
						const header = pendingContainer.createDiv({ cls: 'saloon-pending-header' });
						const headerTitle = header.createEl('h4');
						headerTitle.createSpan({ text: 'Pending approvals ' });
						headerTitle.createEl('span', {
							text: `(${pendingItems.length})`,
							cls: 'saloon-pending-count'
						});

						// Toolbar
						const toolbar = pendingContainer.createDiv({ cls: 'saloon-toolbar' });

						// Filter input with clear button
						const filterGroup = toolbar.createDiv({ cls: 'saloon-filter-group' });
						filterGroup.createEl('label', { text: 'Filter:', cls: 'saloon-filter-label' });
						const filterWrapper = filterGroup.createDiv({ cls: 'saloon-input-wrapper' });
						const filterInput = filterWrapper.createEl('input', {
							type: 'text',
							placeholder: 'Search terms...',
							cls: 'saloon-filter-input'
						});
						const filterClear = filterWrapper.createEl('button', {
							text: '✕',
							cls: 'saloon-input-clear'
						});
						filterClear.addClass('saloon-hidden');
						filterInput.addEventListener('input', () => {
							if (filterInput.value) {
								filterClear.removeClass('saloon-hidden');
							} else {
								filterClear.addClass('saloon-hidden');
							}
						});
						filterClear.addEventListener('click', () => {
							filterInput.value = '';
							filterClear.addClass('saloon-hidden');
							applyFilter();
						});

						// Action type filter
						const actionFilterGroup = toolbar.createDiv({ cls: 'saloon-action-group' });
						actionFilterGroup.createEl('label', { text: 'Type:', cls: 'saloon-filter-label' });
						const actionFilter = actionFilterGroup.createEl('select', { cls: 'saloon-action-select' });
						actionFilter.createEl('option', { value: '', text: 'All types' });
						const actionTypes = ['create_term', 'add_tag', 'add_context', 'trigger_context_search', 'combine_with'];
						actionTypes.forEach(type => {
							actionFilter.createEl('option', { value: type, text: type.replace(/_/g, ' ') });
						});

						// Source filter with clear button
						const sourceFilterGroup = toolbar.createDiv({ cls: 'saloon-action-group' });
						sourceFilterGroup.createEl('label', { text: 'Source:', cls: 'saloon-filter-label' });
						const sourceWrapper = sourceFilterGroup.createDiv({ cls: 'saloon-input-wrapper' });
						const sourceFilter = sourceWrapper.createEl('input', {
							type: 'text',
							placeholder: 'All sources...',
							cls: 'saloon-filter-input saloon-combobox'
						});
						const sourceClear = sourceWrapper.createEl('button', {
							text: '✕',
							cls: 'saloon-input-clear'
						});
						sourceClear.addClass('saloon-hidden');
						sourceFilter.addEventListener('input', () => {
							if (sourceFilter.value) {
								sourceClear.removeClass('saloon-hidden');
							} else {
								sourceClear.addClass('saloon-hidden');
							}
						});
						sourceClear.addEventListener('click', () => {
							sourceFilter.value = '';
							sourceClear.addClass('saloon-hidden');
							applyFilter();
						});
						const sourceDatalist = sourceWrapper.createEl('datalist');
						sourceDatalist.id = 'saloon-source-options-' + Date.now();
						sourceFilter.setAttribute('list', sourceDatalist.id);

						// Collect unique sources from pending items
						const uniqueSources = new Set<string>();
						pendingItems.forEach(item => {
							let td = item.termDetails as { source?: string } | string | null;
							if (typeof td === 'string') {
								try { td = JSON.parse(td) as { source?: string }; } catch { td = null; }
							}
							if (td?.source) uniqueSources.add(td.source);
						});
						Array.from(uniqueSources).sort().forEach(source => {
							const shortName = source.split('/').pop() || source;
							sourceDatalist.createEl('option', { value: shortName, attr: { 'data-full': source } });
						});

						// Map short names to full paths for filtering
						const sourceMap = new Map<string, string>();
						Array.from(uniqueSources).forEach(source => {
							const shortName = source.split('/').pop() || source;
							sourceMap.set(shortName.toLowerCase(), source);
						});

						// Selection controls
						const selectionGroup = toolbar.createDiv({ cls: 'saloon-selection-group' });
						const selectAllBtn = selectionGroup.createEl('button', {
							text: 'Select all',
							cls: 'saloon-select-all-button'
						});
						const selectionCount = selectionGroup.createEl('span', {
							text: '0 selected',
							cls: 'saloon-selection-count'
						});

						// Bulk action buttons (disabled by default)
						const bulkActions = toolbar.createDiv({ cls: 'saloon-bulk-actions' });
						const bulkApproveBtn = bulkActions.createEl('button', {
							text: '✓',
							cls: 'saloon-bulk-approve',
							attr: { title: 'Approve selected', disabled: 'true' }
						});
						const bulkRejectBtn = bulkActions.createEl('button', {
							text: '✕',
							cls: 'saloon-bulk-reject',
							attr: { title: 'Reject selected', disabled: 'true' }
						});

						// Update selection count and button states
						const updateSelectionCount = () => {
							const visibleItems = itemElements.filter(ie => !ie.el.hasClass('saloon-hidden'));
							const visibleSelected = visibleItems.filter(ie => selectedIds.has(ie.item.id)).length;
							selectionCount.textContent = `${visibleSelected} of ${visibleItems.length}`;

							// Enable/disable bulk buttons
							if (visibleSelected > 0) {
								bulkApproveBtn.removeAttribute('disabled');
								bulkRejectBtn.removeAttribute('disabled');
							} else {
								bulkApproveBtn.setAttribute('disabled', 'true');
								bulkRejectBtn.setAttribute('disabled', 'true');
							}
						};

						// Filter function
						const applyFilter = () => {
							const filterText = filterInput.value.toLowerCase();
							const actionType = actionFilter.value;
							const sourceText = sourceFilter.value.toLowerCase();

							itemElements.forEach(({ el, item, termName, source }) => {
								const matchesText = termName.toLowerCase().includes(filterText);
								const matchesAction = !actionType || item.actionType === actionType;
								// Source filter: match against filename or full path
								const shortSource = source.split('/').pop()?.toLowerCase() || '';
								const matchesSource = !sourceText ||
									shortSource.includes(sourceText) ||
									source.toLowerCase().includes(sourceText);
								if (matchesText && matchesAction && matchesSource) {
									el.removeClass('saloon-hidden');
								} else {
									el.addClass('saloon-hidden');
								}
							});
							updateSelectionCount();
						};

						filterInput.addEventListener('input', applyFilter);
						actionFilter.addEventListener('change', applyFilter);
						sourceFilter.addEventListener('input', applyFilter);

						// Select all toggle
						let allSelected = false;
						selectAllBtn.addEventListener('click', () => {
							allSelected = !allSelected;
							itemElements.forEach(({ el, item }) => {
								if (!el.hasClass('saloon-hidden')) {
									const checkbox = el.querySelector('.saloon-card-checkbox') as HTMLInputElement;
									if (checkbox) {
										checkbox.checked = allSelected;
										if (allSelected) {
											selectedIds.add(item.id);
										} else {
											selectedIds.delete(item.id);
										}
									}
								}
							});
							selectAllBtn.textContent = allSelected ? 'Deselect all' : 'Select all';
							updateSelectionCount();
						});

						// Bulk approve handler
						bulkApproveBtn.addEventListener('click', () => {
							void (async () => {
								if (selectedIds.size === 0) {
									new Notice('No items selected');
									return;
								}

								const now = new Date().toISOString();
								let successCount = 0;
								let filesCreated = 0;

								// Ensure glossary folder exists
								const glossaryFolder = this.settings.glossaryFolder || 'Saloon Glossary';
								const folderExists = await this.app.vault.adapter.exists(glossaryFolder);
								if (!folderExists) {
									await this.app.vault.createFolder(glossaryFolder);
								}

								for (const id of selectedIds) {
									const itemData = itemElements.find(ie => ie.item.id === id);
									if (!itemData) continue;

									try {
										// Parse termDetails (may be double-stringified)
										let termDetails = itemData.item.termDetails as { term?: string; definition?: string; context?: string; source?: string } | string | null;
										if (typeof termDetails === 'string') {
											try { termDetails = JSON.parse(termDetails); } catch { termDetails = null; }
										}
										const td = termDetails as { term?: string; definition?: string; context?: string; source?: string } | null;

										if (itemData.item.actionType === 'create_term' && td?.term) {
											const termId = crypto.randomUUID();
											const triples = generateKnowledgeTriples(td.term, td.definition || '');
											// Build context array with text and source
											const contextArray = td.context ? [{
												text: td.context,
												source: td.source || ''
											}] : [];

											await db.insert(terms).values({
												termId: termId,
												term: td.term,
												definition: td.definition || '',
												context: JSON.stringify(contextArray),
												knowledgeTriples: JSON.stringify(triples),
												createdAt: now,
												updatedAt: now
											});

											// Create term file
											const fileName = `${glossaryFolder}/${sanitizeFilename(td.term)}.md`;
											const fileExists = await this.app.vault.adapter.exists(fileName);
											if (!fileExists) {
												const fileContent = generateTermFileContent({
													termId: termId,
													term: td.term,
													definition: td.definition,
													context: td.context,
													sources: td.source ? [td.source] : [],
													createdAt: now
												});
												await this.app.vault.create(fileName, fileContent);
												filesCreated++;
											}
										} else if (itemData.item.actionType === 'update_term' && td?.term && itemData.item.targetTermId) {
											// Get existing term to append context
											const existingTerm = await db.select().from(terms).where(eq(terms.termId, itemData.item.targetTermId));
											let existingContext: Array<{text: string, source: string}> = [];
											if (existingTerm[0]?.context) {
												try {
													existingContext = typeof existingTerm[0].context === 'string'
														? JSON.parse(existingTerm[0].context)
														: existingTerm[0].context;
												} catch { existingContext = []; }
											}
											// Append new context if provided
											if (td.context) {
												existingContext.push({
													text: td.context,
													source: td.source || ''
												});
											}
											// Update existing term
											const updateTriples = generateKnowledgeTriples(td.term, td.definition || '');
											await db.update(terms)
												.set({
													definition: td.definition || '',
													context: JSON.stringify(existingContext),
													knowledgeTriples: JSON.stringify(updateTriples),
													updatedAt: now
												})
												.where(eq(terms.termId, itemData.item.targetTermId));

											// Update the term file changelog
											const fileName = `${glossaryFolder}/${sanitizeFilename(td.term)}.md`;
											const file = this.app.vault.getAbstractFileByPath(fileName);
											if (file instanceof TFile) {
												const content = await this.app.vault.read(file);
												const dateStr = new Date(now).toLocaleDateString('en-US', {
													year: 'numeric',
													month: 'short',
													day: 'numeric'
												});
												const sourceLink = td.source ? `[[${td.source.split('/').pop()?.replace(/\.[^.]+$/, '')}]]` : '';
												const newRow = `| ${dateStr} | Updated | ${td.context ? 'Context updated' : 'Updated'}${sourceLink ? ` from ${sourceLink}` : ''} |`;
												const updatedContent = content.replace(/(\n```saloon-edit)/, `\n${newRow}$1`);
												await this.app.vault.modify(file, updatedContent);
											}
										}

										await db.update(approvalActions)
											.set({ status: 'approved', updatedAt: now })
											.where(eq(approvalActions.id, id));

										successCount++;
									} catch (error) {
										console.error(`Failed to approve ${id}:`, error);
									}
								}

								await this.dbService.saveDatabase(this.databasePath, this.app.vault);
								new Notice(`Approved ${successCount} items${filesCreated > 0 ? `, created ${filesCreated} term files` : ''}`);
								await loadPendingItems();
							})();
						});

						// Bulk reject handler
						bulkRejectBtn.addEventListener('click', () => {
							void (async () => {
								if (selectedIds.size === 0) {
									new Notice('No items selected');
									return;
								}

								const now = new Date().toISOString();
								let successCount = 0;

								for (const id of selectedIds) {
									try {
										await db.update(approvalActions)
											.set({ status: 'rejected', updatedAt: now })
											.where(eq(approvalActions.id, id));
										successCount++;
									} catch (error) {
										console.error(`Failed to reject ${id}:`, error);
									}
								}

								await this.dbService.saveDatabase(this.databasePath, this.app.vault);
								new Notice(`Rejected ${successCount} items`);
								await loadPendingItems();
							})();
						});

						// Items list
						const list = pendingContainer.createDiv({ cls: 'saloon-pending-list' });

						for (const item of pendingItems) {
							// termDetails might be double-stringified for old data
							let termDetails = item.termDetails as { term?: string; definition?: string; context?: string; source?: string } | string | null;
							if (typeof termDetails === 'string') {
								try {
									termDetails = JSON.parse(termDetails);
								} catch {
									termDetails = null;
								}
							}
							const td = termDetails as { term?: string; definition?: string; context?: string; source?: string } | null;
							const termName = td?.term || 'Unknown Term';
							const definition = td?.definition || '';
							const context = td?.context || '';
							const source = td?.source || '';
							const shortSource = source.split('/').pop() || '';

							const itemEl = list.createDiv({ cls: 'saloon-pending-card' });
							itemElements.push({ el: itemEl, item, termName, source });

							// Header row: Checkbox + Term + Actions
							const headerRow = itemEl.createDiv({ cls: 'saloon-card-header' });

							const checkbox = headerRow.createEl('input', {
								type: 'checkbox',
								cls: 'saloon-card-checkbox'
							});
							checkbox.addEventListener('change', () => {
								if (checkbox.checked) {
									selectedIds.add(item.id);
								} else {
									selectedIds.delete(item.id);
									allSelected = false;
									selectAllBtn.textContent = 'Select all';
								}
								updateSelectionCount();
							});

							headerRow.createEl('span', { text: termName, cls: 'saloon-card-term' });

							// Action type icon with tooltip
							const actionIcons: Record<string, { icon: string; label: string }> = {
								'create_term': { icon: '＋', label: 'Create term' },
								'update_term': { icon: '✎', label: 'Update term' },
								'add_tag': { icon: '🏷', label: 'Add tag' },
								'add_context': { icon: '💬', label: 'Add context' },
								'trigger_context_search': { icon: '🔍', label: 'Context search' },
								'combine_with': { icon: '🔗', label: 'Combine with' }
							};
							const actionInfo = actionIcons[item.actionType] || { icon: '•', label: item.actionType };
							const actionIcon = headerRow.createEl('span', {
								text: actionInfo.icon,
								cls: 'saloon-card-action-icon'
							});
							actionIcon.setAttribute('title', actionInfo.label);

							const actions = headerRow.createDiv({ cls: 'saloon-card-actions' });
							const approveBtn = actions.createEl('button', {
								text: '✓',
								cls: 'saloon-btn-approve'
							});
							approveBtn.setAttribute('title', 'Approve');
							const rejectBtn = actions.createEl('button', {
								text: '✕',
								cls: 'saloon-btn-reject'
							});
							rejectBtn.setAttribute('title', 'Reject');

							// Meta row: Source (subdued)
							if (shortSource) {
								itemEl.createEl('div', { text: shortSource, cls: 'saloon-card-source' });
							}

							// Definition (expandable in place)
							if (definition || context) {
								const fullText = definition || context;
								const needsTruncate = fullText.length > 100;
								const truncated = needsTruncate ? fullText.substring(0, 100) + '...' : fullText;

								const defEl = itemEl.createDiv({ cls: 'saloon-card-def' });
								const textSpan = defEl.createSpan({ text: truncated });

								if (needsTruncate) {
									defEl.addClass('is-truncated');
									let isExpanded = false;

									defEl.addEventListener('click', () => {
										isExpanded = !isExpanded;
										textSpan.textContent = isExpanded ? fullText : truncated;
										defEl.toggleClass('is-expanded', isExpanded);
									});
								}
							}

							approveBtn.addEventListener('click', () => {
								void (async () => {
									try {
										const now = new Date().toISOString();
										const termId = crypto.randomUUID();

										if (item.actionType === 'create_term' && td?.term) {
											// Insert term into database
											const triples = generateKnowledgeTriples(td.term, td.definition || '');
											// Build context array with text and source
											const contextArray = td.context ? [{
												text: td.context,
												source: td.source || ''
											}] : [];
											await db.insert(terms).values({
												termId: termId,
												term: td.term,
												definition: td.definition || '',
												context: JSON.stringify(contextArray),
												knowledgeTriples: JSON.stringify(triples),
												createdAt: now,
												updatedAt: now
											});

											// Create term file in glossary folder
											const glossaryFolder = this.settings.glossaryFolder || 'Saloon Glossary';
											const fileName = `${glossaryFolder}/${sanitizeFilename(td.term)}.md`;

											// Ensure glossary folder exists
											const folderExists = await this.app.vault.adapter.exists(glossaryFolder);
											if (!folderExists) {
												await this.app.vault.createFolder(glossaryFolder);
											}

											// Check if file already exists
											const fileExists = await this.app.vault.adapter.exists(fileName);
											if (!fileExists) {
												const fileContent = generateTermFileContent({
													termId: termId,
													term: td.term,
													definition: td.definition,
													context: td.context,
													sources: td.source ? [td.source] : [],
													createdAt: now
												});
												await this.app.vault.create(fileName, fileContent);
												new Notice(`Created term file: ${td.term}`);
											} else {
												new Notice(`Term file already exists: ${td.term}`);
											}
										} else if (item.actionType === 'update_term' && td?.term && item.targetTermId) {
											// Get existing term to append context
											const existingTerm = await db.select().from(terms).where(eq(terms.termId, item.targetTermId));
											let existingContext: Array<{text: string, source: string}> = [];
											if (existingTerm[0]?.context) {
												try {
													existingContext = typeof existingTerm[0].context === 'string'
														? JSON.parse(existingTerm[0].context)
														: existingTerm[0].context;
												} catch { existingContext = []; }
											}
											// Append new context if provided
											if (td.context) {
												existingContext.push({
													text: td.context,
													source: td.source || ''
												});
											}
											// Update existing term in database
											const updateTriples = generateKnowledgeTriples(td.term, td.definition || '');
											await db.update(terms)
												.set({
													definition: td.definition || '',
													context: JSON.stringify(existingContext),
													knowledgeTriples: JSON.stringify(updateTriples),
													updatedAt: now
												})
												.where(eq(terms.termId, item.targetTermId));

											// Update the term file
											const glossaryFolder = this.settings.glossaryFolder || 'Saloon Glossary';
											const fileName = `${glossaryFolder}/${sanitizeFilename(td.term)}.md`;
											const fileExists = await this.app.vault.adapter.exists(fileName);

											if (fileExists) {
												// Read existing file and append to changelog
												const file = this.app.vault.getAbstractFileByPath(fileName);
												if (file instanceof TFile) {
													const content = await this.app.vault.read(file);
													const dateStr = new Date(now).toLocaleDateString('en-US', {
														year: 'numeric',
														month: 'short',
														day: 'numeric'
													});
													const sourceLink = td.source ? `[[${td.source.split('/').pop()?.replace(/\.[^.]+$/, '')}]]` : '';
													const newRow = `| ${dateStr} | Updated | ${td.context ? 'Context updated' : 'Updated'}${sourceLink ? ` from ${sourceLink}` : ''} |`;

													// Insert before the saloon-edit block
													const updatedContent = content.replace(
														/(\n```saloon-edit)/,
														`\n${newRow}$1`
													);
													await this.app.vault.modify(file, updatedContent);
													new Notice(`Updated term file: ${td.term}`);
												}
											}
										}

										await db.update(approvalActions)
											.set({ status: 'approved', updatedAt: now })
											.where(eq(approvalActions.id, item.id));

										await this.dbService.saveDatabase(this.databasePath, this.app.vault);
										new Notice(`Approved: ${termName}`);
										await loadPendingItems();
									} catch (error) {
										console.error('Failed to approve:', error);
										new Notice('Failed to approve item.');
									}
								})();
							});

							rejectBtn.addEventListener('click', () => {
								void (async () => {
									try {
										const now = new Date().toISOString();

										await db.update(approvalActions)
											.set({ status: 'rejected', updatedAt: now })
											.where(eq(approvalActions.id, item.id));

										await this.dbService.saveDatabase(this.databasePath, this.app.vault);
										new Notice(`Rejected: ${termName}`);
										await loadPendingItems();
									} catch (error) {
										console.error('Failed to reject:', error);
										new Notice('Failed to reject item.');
									}
								})();
							});
						}
					} catch (error) {
						console.error('Failed to load pending items:', error);
						pendingContainer.addClass('saloon-hidden');
					}
				};

				// Load pending items on component mount
				await loadPendingItems();

				// Extract button handler
				button.addEventListener('click', () => {
					void (async () => {
						button.disabled = true;
						button.textContent = 'Extracting...';
						resultsContainer.empty();
						progressContainer.removeClass('saloon-hidden');
						progressFill.setCssStyles({ width: '0%' });
						progressText.textContent = 'Starting...';

					try {
						const extractOllamaUrl = ollamaUrl || 'http://localhost:11434';
						const modelName = modelSelect.value;
						let sourcePath = sourceInput.value.trim();

						let extractedTerms: Term[];
						let totalChunksProcessed = 0;
						let totalChunksOverall = 0;

						// Progress update helper
						const updateProgress = (info: ProgressInfo) => {
							totalChunksProcessed++;
							const percent = Math.round((totalChunksProcessed / totalChunksOverall) * 100);
							progressFill.setCssStyles({ width: `${percent}%` });
							if (info.totalFiles && info.currentFileIndex !== undefined) {
								progressText.textContent = `File ${info.currentFileIndex + 1}/${info.totalFiles}: Chunk ${info.currentChunk}/${info.totalChunks}`;
							} else {
								progressText.textContent = `Chunk ${info.currentChunk}/${info.totalChunks}`;
							}
						};

						if (sourcePath) {
							// Extract from directory using Obsidian vault API

							// Convert absolute path to vault-relative if needed
							// @ts-ignore - adapter.basePath exists but not in types
							const vaultBasePath = this.app.vault.adapter.basePath;
							if (sourcePath.startsWith(vaultBasePath)) {
								// Strip vault base path and leading slash
								sourcePath = sourcePath.substring(vaultBasePath.length + 1);
							}

							// Normalize path separators and remove trailing slash
							sourcePath = sourcePath.replace(/\\/g, '/').replace(/\/$/, '');

							// Get all markdown files from the directory
							const allFiles = this.app.vault.getMarkdownFiles();
							const filesInDir = allFiles.filter(f => f.path.startsWith(sourcePath));

							if (filesInDir.length === 0) {
								throw new Error(`No markdown files found in directory: ${sourcePath}. Available paths: ${allFiles.slice(0, 5).map(f => f.path).join(', ')}...`);
							}

							// Pre-calculate total chunks for all files
							const fileContents: { file: TFile; content: string; chunks: string[] }[] = [];
							const chunkSize = parseInt(chunkSlider.value, 10);
							for (let f = 0; f < filesInDir.length; f++) {
								const file = filesInDir[f];
								progressText.textContent = `Scanning file ${f + 1}/${filesInDir.length}...`;
								const content = await this.app.vault.read(file);
								// Strip frontmatter to match what extraction.ts does
								const { content: body } = matter(content);
								const chunks = chunkText(body, { maxChunkSize: chunkSize });
								fileContents.push({ file, content, chunks });
								totalChunksOverall += chunks.length;
							}

							progressText.textContent = `Found ${totalChunksOverall} chunks across ${filesInDir.length} files`;

							// Callback to insert terms as they're extracted and refresh UI
							const onTermsExtracted = async (terms: Term[]) => {
								const now = new Date().toISOString();
								for (const term of terms) {
									try {
										await db.insert(approvalActions).values({
											id: crypto.randomUUID(),
											actionType: 'create_term',
											status: 'pending',
											termDetails: JSON.stringify({
												term: term.term,
												definition: term.definition || '',
												context: term.context || '',
												source: term.source || ''
											}),
											createdAt: now
										});
									} catch (error) {
										console.error(`Failed to insert term ${term.term}:`, error);
									}
								}
								await this.dbService.saveDatabase(this.databasePath, this.app.vault);
								await loadPendingItems();
							};

							// Extract terms from each file
							const allTerms: Term[] = [];
							for (let i = 0; i < fileContents.length; i++) {
								const { file, content } = fileContents[i];

								const options = {
									ollamaBaseUrl: extractOllamaUrl,
									model: modelName || 'llama3.1',
									maxChunkSize: chunkSize,
									onProgress: (info: ProgressInfo) => updateProgress({
										...info,
										totalFiles: filesInDir.length,
										currentFileIndex: i
									}),
									onTermsExtracted
								};

								const terms = await extractTermsFromMarkdown(content, file.path, options);
								allTerms.push(...terms);
							}

							// Deduplicate terms using corpus helper
							extractedTerms = deduplicateTerms(allTerms);
						} else {
							// Extract from current file
							const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
							if (!(file instanceof TFile)) {
								throw new Error('Could not access current file');
							}

							progressText.textContent = 'Reading file...';
							const content = await this.app.vault.read(file);

							// Calculate total chunks for progress (strip frontmatter to match extraction.ts)
							const chunkSize = parseInt(chunkSlider.value, 10);
							const { content: body } = matter(content);
							const chunks = chunkText(body, { maxChunkSize: chunkSize });
							totalChunksOverall = chunks.length;

							progressText.textContent = `Processing ${totalChunksOverall} chunk${totalChunksOverall === 1 ? '' : 's'}...`;

							// Callback to insert terms as they're extracted and refresh UI
							const onTermsExtracted = async (terms: Term[]) => {
								const now = new Date().toISOString();
								for (const term of terms) {
									try {
										await db.insert(approvalActions).values({
											id: crypto.randomUUID(),
											actionType: 'create_term',
											status: 'pending',
											termDetails: JSON.stringify({
												term: term.term,
												definition: term.definition || '',
												context: term.context || '',
												source: term.source || ''
											}),
											createdAt: now
										});
									} catch (error) {
										console.error(`Failed to insert term ${term.term}:`, error);
									}
								}
								await this.dbService.saveDatabase(this.databasePath, this.app.vault);
								await loadPendingItems();
							};

							const options = {
								ollamaBaseUrl: extractOllamaUrl,
								model: modelName || 'llama3.1',
								maxChunkSize: chunkSize,
								onProgress: updateProgress,
								onTermsExtracted
							};

							extractedTerms = await extractTermsFromMarkdown(content, ctx.sourcePath, options);
						}

						// Hide progress bar when done
						progressContainer.addClass('saloon-hidden');

						// Show completion notice
						if (extractedTerms.length > 0) {
							new Notice(`Extraction complete! ${extractedTerms.length} terms added to pending approvals.`);
						} else {
							new Notice('No terms found.');
						}
					} catch (error) {
						console.error('saloon-extract error:', error);
						resultsContainer.empty();
						resultsContainer.createEl('div', {
							text: `Error: ${error.message}`,
							cls: 'saloon-error'
						});
						new Notice('Extraction failed. Check console.');
					} finally {
							button.disabled = false;
							button.textContent = 'Extract terms';
							progressContainer.addClass('saloon-hidden');
						}
					})();
				});
			} catch (error) {
				console.error('saloon-extract initialization error:', error);
				el.createEl('div', { text: `Error: ${error.message}` });
			}
		});

		// MARK: saloon-term-v1 Block (Textarea + Preview Toggle)
		this.registerMarkdownCodeBlockProcessor('saloon-term-v1', async (source, el, ctx) => {
			await this.renderTermBlock(el, ctx, 'textarea');
		});

		// MARK: saloon-term-v2 Block (CodeMirror)
		this.registerMarkdownCodeBlockProcessor('saloon-term-v2', async (source, el, ctx) => {
			await this.renderTermBlock(el, ctx, 'codemirror');
		});

		// MARK: saloon-term-v3 Block (Contenteditable)
		this.registerMarkdownCodeBlockProcessor('saloon-term-v3', async (source, el, ctx) => {
			await this.renderTermBlock(el, ctx, 'contenteditable');
		});

		// MARK: saloon-edit Block
		this.registerMarkdownCodeBlockProcessor('saloon-edit', async (source, el, ctx) => {
			try {
				// Check database is ready
				await this.checkAndReloadDatabase();
				if (!this.dbService || !this.dbService.db) {
					el.createEl('div', { text: 'Error: database not loaded' });
					return;
				}

				const db = this.dbService.db;

				// Get the current file to read its frontmatter
				const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
				if (!(file instanceof TFile)) {
					el.createEl('div', { text: 'Could not access current file' });
					return;
				}

				const content = await this.app.vault.read(file);
				const { data: frontmatter } = matter(content);
				const termId = frontmatter.termId;
				const termName = frontmatter.term || file.basename;

				if (!termId) {
					el.createEl('div', { text: 'No termId found in frontmatter', cls: 'saloon-warning' });
					return;
				}

				// Query term from database
				const termRecord = await db.select().from(terms).where(eq(terms.termId, termId));
				const term = termRecord[0];

				// Create edit button container
				const container = el.createDiv({ cls: 'saloon-edit-container' });

				const editBtn = container.createEl('button', {
					text: 'Edit term',
					cls: 'saloon-edit-button'
				});

				editBtn.addEventListener('click', () => {
					// Create modal overlay
					const overlay = document.body.createDiv({ cls: 'saloon-modal-overlay' });
					const modal = overlay.createDiv({ cls: 'saloon-modal' });

					modal.createEl('h3', { text: `Edit: ${termName}` });

					// Definition field
					const defGroup = modal.createDiv({ cls: 'saloon-modal-group' });
					defGroup.createEl('label', { text: 'Definition:' });
					const defInput = defGroup.createEl('textarea', {
						cls: 'saloon-modal-textarea'
					});
					// Try to extract definition from file content
					const defMatch = content.match(/## Definition\n([\s\S]*?)(?=\n##|$)/);
					defInput.value = defMatch ? defMatch[1].trim() : '';

					// Context field
					const ctxGroup = modal.createDiv({ cls: 'saloon-modal-group' });
					ctxGroup.createEl('label', { text: 'Context:' });
					const ctxInput = ctxGroup.createEl('textarea', {
						cls: 'saloon-modal-textarea'
					});
					// Try to extract context from file content
					const ctxMatch = content.match(/## Context\n([\s\S]*?)(?=\n(?:Source:|##)|$)/);
					ctxInput.value = ctxMatch ? ctxMatch[1].trim() : '';

					// Buttons
					const btnRow = modal.createDiv({ cls: 'saloon-modal-buttons' });

					const saveBtn = btnRow.createEl('button', {
						text: 'Save',
						cls: 'saloon-save-button'
					});

					const cancelBtn = btnRow.createEl('button', {
						text: 'Cancel',
						cls: 'saloon-cancel-button'
					});

					saveBtn.addEventListener('click', () => {
						void (async () => {
							try {
								const now = new Date().toISOString();
								const newDef = defInput.value.trim();
								const newCtx = ctxInput.value.trim();

								// Update database
								if (term) {
									const updateTriples = generateKnowledgeTriples(term.term, newDef);
									// For edit modal, replace context with single entry (no source available)
									const contextArray = newCtx ? [{ text: newCtx, source: '' }] : [];
									await db.update(terms)
										.set({
											definition: newDef,
											context: JSON.stringify(contextArray),
											knowledgeTriples: JSON.stringify(updateTriples),
											updatedAt: now
										})
										.where(eq(terms.termId, termId));

									await this.dbService.saveDatabase(this.databasePath, this.app.vault);
								}

								// Update file content
								let updatedContent = content;

								// Update definition section
								if (defMatch) {
									updatedContent = updatedContent.replace(
										/## Definition\n[\s\S]*?(?=\n##|$)/,
										`## Definition\n${newDef}\n`
									);
								}

								// Update context section
								if (ctxMatch) {
									updatedContent = updatedContent.replace(
										/## Context\n[\s\S]*?(?=\n(?:Source:|##)|$)/,
										`## Context\n${newCtx}\n\n`
									);
								}

								// Update frontmatter updatedAt
								updatedContent = updatedContent.replace(
									/updatedAt: .*/,
									`updatedAt: ${now}`
								);

								// Add changelog entry
								const dateStr = new Date(now).toLocaleDateString('en-US', {
									year: 'numeric',
									month: 'short',
									day: 'numeric'
								});
								const newRow = `| ${dateStr} | Edited | Manual edit |`;
								updatedContent = updatedContent.replace(
									/(\n```saloon-edit)/,
									`\n${newRow}$1`
								);

								await this.app.vault.modify(file, updatedContent);

								overlay.remove();
								new Notice(`Updated: ${termName}`);

								// Trigger re-render
								this.app.workspace.trigger('layout-change');
							} catch (error) {
								console.error('Failed to save term:', error);
								new Notice('Failed to save term.');
							}
						})();
					});

					cancelBtn.addEventListener('click', () => {
						overlay.remove();
					});

					// Close on overlay click
					overlay.addEventListener('click', (e) => {
						if (e.target === overlay) {
							overlay.remove();
						}
					});
				});

			} catch (error) {
				console.error('saloon-edit error:', error);
				el.createEl('div', { text: `Error: ${error.message}` });
			}
		});

		/* MARK: Commands */

		// Reload database from disk
		this.addCommand({
			id: 'reload-database',
			name: 'Reload database from disk',
			callback: async () => {
				try {
					const adapter = this.app.vault.adapter;
					const wasmBinary = await adapter.readBinary(this.wasmPath);

					// Re-initialize database from _saloon folder
					this.dbService = new DrizzleDatabase();
					await this.dbService.initialize(wasmBinary, this.databasePath, this.app.vault);

					new Notice('Database reloaded from disk!');

					// Trigger re-render
					this.app.workspace.trigger('layout-change');
				} catch (error) {
					console.error('Failed to reload database:', error);
					new Notice('Failed to reload database. Check console.');
				}
			}
		});

		// Add command to insert sample data
		this.addCommand({
			id: 'insert-sample-data',
			name: 'Insert sample data',
			callback: async () => {
				try {
					if (!this.dbService || !this.dbService.db) {
						new Notice('Database not loaded');
						return;
					}

					const db = this.dbService.db;

					// Insert sample term
					const sampleDef = 'A branch of artificial intelligence that enables systems to learn and improve from experience without being explicitly programmed.';
					const sampleTriples = generateKnowledgeTriples('Machine Learning', sampleDef);
					const sampleContext = [{
						text: 'Important for AI onboarding and understanding modern data systems.',
						source: 'Sample Document.md'
					}];
					await db.insert(terms).values({
						termId: crypto.randomUUID(),
						term: 'Machine Learning',
						definition: sampleDef,
						context: JSON.stringify(sampleContext),
						aliases: JSON.stringify([
							{ type: 'aka', value: 'ML' },
							{ type: 'fka', value: 'Statistical Learning' }
						]),
						knowledgeTriples: JSON.stringify(sampleTriples),
						tags: JSON.stringify(['technology', 'ai']),
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					});

					// Insert sample approval action
					await db.insert(approvalActions).values({
						id: crypto.randomUUID(),
						actionType: 'create_term',
						targetTermId: null,
						status: 'pending',
						createdAt: new Date().toISOString(),
					});

					// Save database to _saloon folder
					await this.dbService.saveDatabase(this.databasePath, this.app.vault);

					new Notice('Sample data inserted successfully!');
				} catch (error) {
					console.error('Failed to insert sample data:', error);
					new Notice('Failed to insert sample data. Check console.');
				}
			}
		});

		/* MARK: Settings Tab */
		this.addSettingTab(new SaloonSettingTab(this.app, this));
	}

	// MARK: Render Term Block

	async renderTermBlock(el: HTMLElement, ctx: { sourcePath: string }, _editorType: 'textarea' | 'codemirror' | 'contenteditable') {
		try {
			// Check database is ready
			await this.checkAndReloadDatabase();
			if (!this.dbService || !this.dbService.db) {
				el.createEl('div', { text: 'Error: database not loaded' });
				return;
			}

			const db = this.dbService.db;

			// Create a component for markdown rendering lifecycle
			const renderComponent = new Component();
			renderComponent.load();

			// Get the current file to read its frontmatter
			const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
			if (!(file instanceof TFile)) {
				el.createEl('div', { text: 'Could not access current file' });
				return;
			}

			const content = await this.app.vault.read(file);
			const { data: frontmatter } = matter(content);
			const termId = frontmatter.termId;

			if (!termId) {
				el.createEl('div', { text: 'No termId found in frontmatter', cls: 'saloon-warning' });
				return;
			}

			// Query term from database
			const termRecord = await db.select().from(terms).where(eq(terms.termId, termId));
			const dbTerm = termRecord[0];

			// Create minimal container
			const container = el.createDiv({ cls: 'saloon-term-minimal' });

			// Term name header
			const termName = frontmatter.term || file.basename;
			container.createEl('h1', { text: termName, cls: 'saloon-term-title' });

			// Helper to check if values differ
			const valuesDiffer = (fileVal: string, dbVal: string | null | undefined): boolean => {
				const f = (fileVal || '').trim();
				const d = (dbVal || '').trim();
				return f !== d;
			};

			// Helper to create section with save button
			const createSection = (
				sectionName: string,
				fileValue: string,
				dbValue: string | null | undefined,
				onSaveToDb: (newValue: string) => Promise<void>
			) => {
				const section = container.createDiv({ cls: 'saloon-section-minimal' });

				// Section header with action icons
				const sectionHeader = section.createDiv({ cls: 'saloon-section-header-minimal' });
				sectionHeader.createEl('h3', { text: sectionName });

				const actionButtons = sectionHeader.createDiv({ cls: 'saloon-action-icons' });

				// Cancel button (X) - hidden by default, shown during edit
				const cancelBtn = actionButtons.createEl('button', {
					text: '✕',
					cls: 'saloon-icon-btn saloon-icon-cancel saloon-hidden',
					attr: { title: 'Cancel editing' }
				});

				// Save button (disk icon) - disabled until edits made
				const saveBtn = actionButtons.createEl('button', {
					text: '💾',
					cls: 'saloon-icon-btn saloon-icon-save saloon-icon-disabled',
					attr: { title: 'Save to database', disabled: 'true' }
				});

				// Track state
				let isEditing = false;
				let hasUserEdited = false;
				let currentEditorValue = fileValue;

				const updateSaveButtonState = () => {
					const differsFromDb = valuesDiffer(currentEditorValue, dbValue);
					if (hasUserEdited && differsFromDb) {
						saveBtn.removeAttribute('disabled');
						saveBtn.removeClass('saloon-icon-disabled');
					} else {
						saveBtn.setAttribute('disabled', 'true');
						saveBtn.addClass('saloon-icon-disabled');
					}
				};

				const enterEditMode = () => {
					isEditing = true;
					preview.addClass('saloon-hidden');
					textarea.removeClass('saloon-hidden');
					cancelBtn.removeClass('saloon-hidden');
					textarea.focus();
					section.addClass('saloon-editing');
				};

				const exitEditMode = (updatePreview: boolean) => {
					isEditing = false;
					textarea.addClass('saloon-hidden');
					cancelBtn.addClass('saloon-hidden');
					preview.removeClass('saloon-hidden');
					section.removeClass('saloon-editing');
					if (updatePreview) {
						preview.empty();
						void MarkdownRenderer.render(this.app, currentEditorValue || '*No content*', preview, ctx.sourcePath, renderComponent);
					}
				};

				saveBtn.addEventListener('click', () => {
					void (async () => {
						await onSaveToDb(currentEditorValue);
						hasUserEdited = false;
						updateSaveButtonState();
						exitEditMode(true);
					})();
				});

				cancelBtn.addEventListener('click', () => {
					// Reset to original value
					currentEditorValue = fileValue;
					textarea.value = fileValue;
					hasUserEdited = false;
					updateSaveButtonState();
					exitEditMode(false);
				});

				// Content area
				const contentWrapper = section.createDiv({ cls: 'saloon-content-wrapper' });

				// Preview (default view) - double-click to edit
				const preview = contentWrapper.createDiv({ cls: 'saloon-preview-minimal' });
				void MarkdownRenderer.render(this.app, fileValue || '*No content*', preview, ctx.sourcePath, renderComponent);

				preview.addEventListener('dblclick', () => {
					if (!isEditing) {
						enterEditMode();
					}
				});

				// Textarea (hidden by default)
				const textarea = contentWrapper.createEl('textarea', {
					cls: 'saloon-textarea-minimal saloon-hidden'
				});
				textarea.value = fileValue;

				// Track changes in textarea
				textarea.addEventListener('input', () => {
					hasUserEdited = true;
					currentEditorValue = textarea.value;
					updateSaveButtonState();
				});

				return section;
			};

			// Extract current file values - stop at code block or next section
			const defMatch = content.match(/## Definition\n([\s\S]*?)(?=\n## |\n```)/);
			const ctxMatch = content.match(/## Context\n([\s\S]*?)(?=\n## |\n```)/);
			const triplesMatch = content.match(/## Knowledge Triples\n([\s\S]*?)(?=\n## |\n```)/);

			const fileDefinition = defMatch ? defMatch[1].trim() : '';
			const fileContext = ctxMatch ? ctxMatch[1].trim() : '';
			const fileTriples = triplesMatch ? triplesMatch[1].trim() : '';

			// Get DB values
			const dbDefinition = dbTerm?.definition || '';

			// Parse context array and format as markdown with source links
			let dbContextStr = '';
			if (dbTerm?.context) {
				try {
					const contextArray = typeof dbTerm.context === 'string'
						? JSON.parse(dbTerm.context)
						: dbTerm.context;
					if (Array.isArray(contextArray) && contextArray.length > 0) {
						dbContextStr = contextArray.map((c: {text: string, source: string}) => {
							const sourceLink = c.source ? `\n  — *Source: [[${c.source.split('/').pop()?.replace(/\.[^.]+$/, '')}]]*` : '';
							return `${c.text}${sourceLink}`;
						}).join('\n\n');
					}
				} catch {
					// Fallback for legacy plain text context
					dbContextStr = typeof dbTerm.context === 'string' ? dbTerm.context : '';
				}
			}

			let dbTriplesStr = '';
			if (dbTerm?.knowledgeTriples) {
				const triples = typeof dbTerm.knowledgeTriples === 'string'
					? JSON.parse(dbTerm.knowledgeTriples) as { subject: string; predicate: string; target: string }[]
					: dbTerm.knowledgeTriples;
				if (Array.isArray(triples)) {
					dbTriplesStr = '| Subject | Predicate | Target |\n|---------|-----------|--------|\n' +
						triples.map((t: { subject: string; predicate: string; target: string }) => `| ${t.subject} | ${t.predicate} | ${t.target} |`).join('\n');
				}
			}

			// Use DB values as fallback when file values are empty
			const displayDefinition = fileDefinition || dbDefinition;
			const displayContext = fileContext || dbContextStr;
			const displayTriples = fileTriples || dbTriplesStr;

			// Definition section - use displayDefinition which falls back to DB value
			createSection(
				'Definition',
				displayDefinition,
				dbDefinition,
				async (newValue) => {
					const now = new Date().toISOString();
					await db.update(terms)
						.set({ definition: newValue, updatedAt: now, lastSyncedAt: now })
						.where(eq(terms.termId, termId));
					await this.dbService.saveDatabase(this.databasePath, this.app.vault);
					new Notice('Definition saved to database');
				}
			);

			// Context section - use displayContext which falls back to DB value
			createSection(
				'Context',
				displayContext,
				dbContextStr,
				async (newValue) => {
					const now = new Date().toISOString();
					// Store as single context entry (manual edits replace existing contexts)
					const contextArray = newValue.trim() ? [{ text: newValue.trim(), source: '' }] : [];
					await db.update(terms)
						.set({ context: JSON.stringify(contextArray), updatedAt: now, lastSyncedAt: now })
						.where(eq(terms.termId, termId));
					await this.dbService.saveDatabase(this.databasePath, this.app.vault);
					new Notice('Context saved to database');
				}
			);

			// Knowledge Triples section - use displayTriples which falls back to DB value
			createSection(
				'Knowledge Triples',
				displayTriples,
				dbTriplesStr,
				async (newValue) => {
					// Parse markdown table back to JSON
					const lines = newValue.split('\n').filter(l => l.trim().startsWith('|') && !l.includes('---'));
					const triples: { subject: string; predicate: string; target: string }[] = [];

					// Skip header row
					for (let i = 1; i < lines.length; i++) {
						const cells = lines[i].split('|').map(c => c.trim()).filter(c => c);
						if (cells.length >= 3) {
							triples.push({
								subject: cells[0],
								predicate: cells[1],
								target: cells[2]
							});
						}
					}

					const now = new Date().toISOString();
					await db.update(terms)
						.set({ knowledgeTriples: JSON.stringify(triples), updatedAt: now, lastSyncedAt: now })
						.where(eq(terms.termId, termId));
					await this.dbService.saveDatabase(this.databasePath, this.app.vault);
					new Notice('Knowledge triples saved to database');
				}
			);

			// Changelog section (read-only from DB) - minimal
			const changelogSection = container.createDiv({ cls: 'saloon-section-minimal' });
			const changelogHeader = changelogSection.createDiv({ cls: 'saloon-section-header-minimal' });
			changelogHeader.createEl('h3', { text: 'History' });

			const changelogContent = changelogSection.createDiv({ cls: 'saloon-changelog-minimal' });

			// Build changelog from DB timestamps
			if (dbTerm?.createdAt) {
				const created = new Date(dbTerm.createdAt);
				const createdDate = created.toLocaleDateString('en-US', {
					year: 'numeric', month: 'short', day: 'numeric'
				});
				const createdTime = created.toLocaleTimeString('en-US', {
					hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
				});
				changelogContent.createEl('div', {
					text: `${createdDate} ${createdTime} — Created`,
					cls: 'saloon-changelog-entry'
				});
			}

			if (dbTerm?.updatedAt && dbTerm.updatedAt !== dbTerm.createdAt) {
				const updated = new Date(dbTerm.updatedAt);
				const updatedDate = updated.toLocaleDateString('en-US', {
					year: 'numeric', month: 'short', day: 'numeric'
				});
				const updatedTime = updated.toLocaleTimeString('en-US', {
					hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
				});
				changelogContent.createEl('div', {
					text: `${updatedDate} ${updatedTime} — Updated`,
					cls: 'saloon-changelog-entry'
				});
			}

			if (!dbTerm?.createdAt && !dbTerm?.updatedAt) {
				changelogContent.createEl('div', {
					text: 'No history',
					cls: 'saloon-changelog-empty'
				});
			}

		} catch (error) {
			console.error('saloon-term render error:', error);
			el.createEl('div', { text: `Error: ${error.message}` });
		}
	}

	// MARK: Unload

	onunload() {
		this.dbService.close();
	}

	// MARK: Database Reload

	async checkAndReloadDatabase(): Promise<void> {
		try {
			const adapter = this.app.vault.adapter;
			const stat = await adapter.stat(this.databasePath);

			if (!stat) return;

			// If file was modified, reload it
			if (stat.mtime > this.lastDbModTime) {
				const wasmBinary = await adapter.readBinary(this.wasmPath);

				// Re-initialize database
				this.dbService = new DrizzleDatabase();
				await this.dbService.initialize(wasmBinary, this.databasePath, this.app.vault);

				// Update last modified time
				this.lastDbModTime = stat.mtime;
			}
		} catch (error) {
			console.error('Error checking database file:', error);
		}
	}

	// MARK: Settings Management

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

/* MARK: - Settings UI */
class SaloonSettingTab extends PluginSettingTab {
	plugin: SaloonPlugin;

	// MARK: Constructor

	constructor(app: App, plugin: SaloonPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// MARK: Display

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		// Glossary Folder setting
		new Setting(containerEl)
			.setName('Glossary folder')
			.setDesc('Folder where term files will be created when approved. Relative to vault root.')
			.addText(text => text
				.setPlaceholder('saloon-glossary')
				.setValue(this.plugin.settings.glossaryFolder)
				.onChange(async (value) => {
					this.plugin.settings.glossaryFolder = value;
					await this.plugin.saveSettings();
				}));

		// Ollama URL setting
		new Setting(containerEl)
			.setName('Ollama API URL')
			.setDesc('Base URL for the Ollama API server used for term extraction')
			.addText(text => text
				.setPlaceholder('http://localhost:11434')
				.setValue(this.plugin.settings.ollamaUrl)
				.onChange(async (value) => {
					this.plugin.settings.ollamaUrl = value;
					await this.plugin.saveSettings();
					// Also update database setting for backward compatibility
					if (this.plugin.dbService?.db) {
						const now = new Date().toISOString();
						await this.plugin.dbService.db.insert(settings)
							.values({ key: 'extract.ollamaUrl', value, updatedAt: now })
							.onConflictDoUpdate({
								target: settings.key,
								set: { value, updatedAt: now }
							});
						await this.plugin.dbService.saveDatabase(this.plugin.databasePath, this.plugin.app.vault);
					}
				}));

		new Setting(containerEl)
			.setName('Database info')
			.setHeading();

		new Setting(containerEl)
			.setName('Storage location')
			.setDesc(`The plugin stores a database file named "${DATABASE_FILENAME}" in the ${SALOON_FOLDER} folder with approval_actions and terms tables.`);
	}
}
