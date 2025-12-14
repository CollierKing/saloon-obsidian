import { z } from 'zod';

// Single extracted term
export const TermSchema = z.object({
  term: z.string().describe('The technical term or acronym'),
  definition: z.string().describe('Clear 1-2 sentence definition'),
  context: z.string().describe('Context where this term was found'),
  source: z.string().optional().describe('Source file path')
});

// Response from LLM
export const ExtractedTermsSchema = z.object({
  terms: z.array(TermSchema)
});

// TypeScript types
export type Term = z.infer<typeof TermSchema>;
export type ExtractedTerms = z.infer<typeof ExtractedTermsSchema>;
