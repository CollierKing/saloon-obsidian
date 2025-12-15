// Public API exports
export { extractTermsFromMarkdown } from './extraction';
export { deduplicateTerms, chunkText } from './helpers';
export type { Term, ExtractedTerms } from './types';
export type { MarkdownFile, ChunkOptions } from './helpers';
export type { ExtractionOptions, ProgressInfo, ProgressCallback } from './extraction';
