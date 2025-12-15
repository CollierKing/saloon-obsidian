import { ChatOllama } from '@langchain/ollama';
import { createAgent, toolStrategy } from 'langchain';
import { Term, ExtractedTermsSchema } from './types';
import { extractFrontmatter, deduplicateTerms, chunkText } from './helpers';

// MARK: - Polyfills

// Polyfill for AbortSignal.any (not available in Obsidian's Electron environment)
if (!(AbortSignal as unknown as { any?: unknown }).any) {
  (AbortSignal as unknown as { any: (signals: AbortSignal[]) => AbortSignal }).any = function(signals: AbortSignal[]): AbortSignal {
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

/** Configuration for ChatOllama */
interface OllamaConfig {
  model: string;
  temperature: number;
  numPredict: number;
  numCtx: number;
  baseUrl?: string;
}

/**
 * Create extraction agent with Ollama LLM and toolStrategy
 */
function createExtractionAgent(options?: ExtractionOptions) {
  const config: OllamaConfig = {
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

  /* eslint-disable @typescript-eslint/no-explicit-any -- langchain types are not fully typed for this use case */
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
  /* eslint-enable @typescript-eslint/no-explicit-any */

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
