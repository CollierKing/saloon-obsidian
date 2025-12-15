import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";
import js from "@eslint/js";

export default tseslint.config(
	{
		ignores: ["node_modules/**", "main.js", "**/*.mjs", "dist/**"],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		plugins: {
			obsidianmd,
		},
		rules: {
			// Obsidian plugin rules
			"obsidianmd/commands/no-command-in-command-id": "error",
			"obsidianmd/commands/no-command-in-command-name": "error",
			"obsidianmd/commands/no-default-hotkeys": "error",
			"obsidianmd/commands/no-plugin-id-in-command-id": "error",
			"obsidianmd/commands/no-plugin-name-in-command-name": "error",
			"obsidianmd/settings-tab/no-manual-html-headings": "error",
			"obsidianmd/settings-tab/no-problematic-settings-headings": "error",
			"obsidianmd/vault/iterate": "error",
			"obsidianmd/detach-leaves": "error",
			"obsidianmd/hardcoded-config-path": "error",
			"obsidianmd/no-forbidden-elements": "error",
			"obsidianmd/no-plugin-as-component": "error",
			"obsidianmd/no-sample-code": "error",
			"obsidianmd/no-tfile-tfolder-cast": "warn",
			"obsidianmd/no-view-references-in-plugin": "error",
			"obsidianmd/no-static-styles-assignment": "error",
			"obsidianmd/object-assign": "error",
			"obsidianmd/platform": "error",
			"obsidianmd/prefer-abstract-input-suggest": "warn",
			"obsidianmd/prefer-file-manager-trash-file": "warn",
			"obsidianmd/regex-lookbehind": "error",
			"obsidianmd/sample-names": "error",
			"obsidianmd/validate-manifest": "error",
			"obsidianmd/validate-license": "error",
			"obsidianmd/ui/sentence-case": ["error", {
				// Add custom brand names that should preserve their casing
				brands: ["Saloon", "Ollama"],
				// Ignore URL placeholders and folder paths with underscores
				ignoreRegex: ["^https?://", "^[a-z-]+$", "_saloon"]
			}],

			// TypeScript rules - match review bot requirements
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/require-await": "error",
			"@typescript-eslint/ban-ts-comment": "off",
			"@typescript-eslint/no-base-to-string": "error",
			"@typescript-eslint/no-misused-promises": ["error", {
				checksVoidReturn: {
					arguments: true,
					attributes: false,
				},
			}],
			"no-prototype-builtins": "off",
		},
	}
);
