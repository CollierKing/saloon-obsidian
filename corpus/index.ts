// Public API exports
export { extractTerms, extractTermsFromMarkdown } from './extraction';
export { loadMarkdownFiles, deduplicateTerms, chunkText } from './helpers';
export type { Term, ExtractedTerms } from './types';
export type { MarkdownFile, ChunkOptions } from './helpers';
export type { ExtractionOptions, ProgressInfo, ProgressCallback } from './extraction';
