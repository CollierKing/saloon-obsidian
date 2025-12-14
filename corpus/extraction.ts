// fs import removed - not used (file operations handled by Obsidian vault API)
import { ChatOllama } from '@langchain/ollama';
import { createAgent, toolStrategy } from 'langchain';
import { Term, ExtractedTermsSchema } from './types';
import { loadMarkdownFiles, extractFrontmatter, deduplicateTerms, chunkText } from './helpers';

// MARK: - Polyfills

// Polyfill for AbortSignal.any (not available in Obsidian's Electron environment)
if (!(AbortSignal as any).any) {
  (AbortSignal as any).any = function(signals: AbortSignal[]): AbortSignal {
    const controller = new AbortController();

    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort();
        return controller.signal;
      }

      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    return controller.signal;
  };
}

// MARK: - Types

export interface ProgressInfo {
  currentChunk: number;
  totalChunks: number;
  currentFile?: string;
  totalFiles?: number;
  currentFileIndex?: number;
}

export type ProgressCallback = (progress: ProgressInfo) => void;

export type TermsExtractedCallback = (terms: Term[]) => Promise<void>;

export interface ExtractionOptions {
  ollamaBaseUrl?: string;
  model?: string;
  outputDir?: string;
  maxChunkSize?: number;
  onProgress?: ProgressCallback;
  onTermsExtracted?: TermsExtractedCallback;
}

// MARK: - Agent Creation

/**
 * Create extraction agent with Ollama LLM and toolStrategy
 */
function createExtractionAgent(options?: ExtractionOptions) {
  const config: any = {
    model: options?.model || "gpt-oss:20b",
    temperature: 0.0,
    numPredict: 16000,  // max output tokens
    numCtx: 128000      // context window
  };

  // Add baseUrl if provided
  if (options?.ollamaBaseUrl) {
    config.baseUrl = options.ollamaBaseUrl;
  }

  const llm = new ChatOllama(config);

  const agent = createAgent({
    systemPrompt: `You are an expert at extracting technical terms from documents.

Extract all technical terms, acronyms, and jargon from the text.
For each term provide:
- The term itself
- A clear 1-2 sentence definition
- The context where it appeared

Focus on:
- Technical terminology
- Industry-specific jargon
- Acronyms and abbreviations
- Specialized concepts
- Domain-specific vocabulary

Do not include common words or general vocabulary.`,
    model: llm,
    responseFormat: toolStrategy(ExtractedTermsSchema as any, {
      handleError: true,
    }) as any,
  } as any);

  return agent;
}

// MARK: - Private Helpers

/**
 * Extract terms from a single text using agent with toolStrategy
 */
async function extractTermsFromText(
  content: string,
  filePath: string,
  options?: ExtractionOptions
): Promise<Term[]> {
  try {
    const agent = createExtractionAgent(options);

    // Invoke agent with user message
    const response = await agent.invoke({
      messages: [
        { role: "user", content: content }
      ]
    });

    // Access structured response (equivalent to Python's res.get("structured_response"))
    const structuredResponse = response.structuredResponse;

    if (structuredResponse && structuredResponse.terms) {
      // Add source file path to each term
      return structuredResponse.terms.map((term: Term) => ({
        ...term,
        source: filePath
      }));
    }

    console.error(`No structured response for ${filePath}`);
    return [];
  } catch (error) {
    console.error(`Error extracting terms from ${filePath}:`, error);
    return [];
  }
}

// MARK: - Public API

/**
 * Main pipeline: extract terms from markdown files
 * Note: This function uses Node.js fs operations and should only be used
 * in Node.js environments (not in Obsidian plugin)
 */
export async function extractTerms(
  inputPath: string,
  options?: ExtractionOptions
): Promise<Term[]> {
  // 1. Load files
  console.log(`Loading markdown files from: ${inputPath}`);
  const files = await loadMarkdownFiles(inputPath);
  console.log(`Found ${files.length} markdown files`);

  // 2. Extract terms from each file
  const allTerms: Term[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    console.log(`[${i + 1}/${files.length}] Extracting terms from: ${file.path}`);

    const { body } = extractFrontmatter(file.content);
    const terms = await extractTermsFromText(body, file.path, options);

    console.log(`  Found ${terms.length} terms`);
    allTerms.push(...terms);
  }

  console.log(`Total terms extracted: ${allTerms.length}`);

  // 3. Deduplicate
  const uniqueTerms = deduplicateTerms(allTerms);
  console.log(`Unique terms after deduplication: ${uniqueTerms.length}`);

  // Note: File saving removed for Obsidian compatibility
  // Results are returned and can be saved using Obsidian's vault API

  return uniqueTerms;
}

/**
 * Extract terms from text directly (for Obsidian integration)
 * Chunks large documents and processes sequentially with progress updates
 */
export async function extractTermsFromMarkdown(
  content: string,
  sourcePath?: string,
  options?: ExtractionOptions
): Promise<Term[]> {
  const { body } = extractFrontmatter(content);
  const filePath = sourcePath || 'unknown';

  // Chunk the content
  const chunks = chunkText(body, { maxChunkSize: options?.maxChunkSize || 4000 });
  const allTerms: Term[] = [];

  // Process each chunk sequentially
  for (let i = 0; i < chunks.length; i++) {
    const terms = await extractTermsFromText(chunks[i], filePath, options);
    allTerms.push(...terms);

    // Call onTermsExtracted callback with new terms from this chunk
    if (options?.onTermsExtracted && terms.length > 0) {
      await options.onTermsExtracted(terms);
    }

    // Report progress AFTER chunk completes
    if (options?.onProgress) {
      options.onProgress({
        currentChunk: i + 1,
        totalChunks: chunks.length,
        currentFile: filePath
      });
    }
  }

  // Deduplicate terms from this file (may have overlaps from chunk boundaries)
  return deduplicateTerms(allTerms);
}
