import * as fs from 'fs/promises';
import * as path from 'path';
import matter from 'gray-matter';
import { Term } from './types';

// MARK: - Chunking

export interface ChunkOptions {
  maxChunkSize?: number;  // Max characters per chunk (default: 4000)
  overlap?: number;       // Character overlap between chunks (default: 200)
}

/**
 * Split text into chunks for processing
 * Tries to split on paragraph boundaries when possible
 */
export function chunkText(text: string, options?: ChunkOptions): string[] {
  const maxSize = options?.maxChunkSize || 4000;
  const overlap = options?.overlap || 200;

  // If text is small enough, return as single chunk
  if (text.length <= maxSize) {
    return [text];
  }

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);

  let currentChunk = '';

  for (const paragraph of paragraphs) {
    // If adding this paragraph would exceed max size
    if (currentChunk.length + paragraph.length + 2 > maxSize) {
      // Save current chunk if it has content
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
        // Start new chunk with overlap from end of previous
        const overlapText = currentChunk.slice(-overlap);
        currentChunk = overlapText + '\n\n' + paragraph;
      } else {
        // Paragraph itself is too long, split it by sentences
        const sentences = paragraph.match(/[^.!?]+[.!?]+/g) || [paragraph];
        for (const sentence of sentences) {
          if (currentChunk.length + sentence.length > maxSize) {
            if (currentChunk.trim()) {
              chunks.push(currentChunk.trim());
              currentChunk = currentChunk.slice(-overlap) + ' ' + sentence;
            } else {
              // Single sentence too long, force split
              chunks.push(sentence.slice(0, maxSize));
              currentChunk = sentence.slice(maxSize - overlap);
            }
          } else {
            currentChunk += sentence;
          }
        }
      }
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
    }
  }

  // Don't forget the last chunk
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

export interface MarkdownFile {
  path: string;
  content: string;
  frontmatter?: Record<string, any>;
}

/**
 * Load single file or all .md files from directory
 */
export async function loadMarkdownFiles(inputPath: string): Promise<MarkdownFile[]> {
  const stats = await fs.stat(inputPath);

  if (stats.isFile()) {
    // Single file
    const content = await fs.readFile(inputPath, 'utf-8');
    const { data, content: body } = matter(content);
    return [{
      path: inputPath,
      content: body,
      frontmatter: data
    }];
  } else if (stats.isDirectory()) {
    // Directory - recursively find all .md files
    const markdownFiles: MarkdownFile[] = [];

    async function scanDirectory(dir: string) {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await scanDirectory(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const content = await fs.readFile(fullPath, 'utf-8');
          const { data, content: body } = matter(content);
          markdownFiles.push({
            path: fullPath,
            content: body,
            frontmatter: data
          });
        }
      }
    }

    await scanDirectory(inputPath);
    return markdownFiles;
  } else {
    throw new Error(`Invalid path: ${inputPath}`);
  }
}

/**
 * Parse YAML frontmatter from markdown content
 */
export function extractFrontmatter(content: string): {
  frontmatter: Record<string, any>;
  body: string;
} {
  const { data, content: body } = matter(content);
  return {
    frontmatter: data,
    body
  };
}

/**
 * Merge duplicate terms by combining definitions
 */
export function deduplicateTerms(terms: Term[]): Term[] {
  const termMap = new Map<string, Term>();

  for (const term of terms) {
    const key = term.term.toLowerCase().trim();

    if (termMap.has(key)) {
      // Merge with existing term
      const existing = termMap.get(key)!;

      // Combine definitions if different
      if (existing.definition !== term.definition) {
        existing.definition = `${existing.definition} | ${term.definition}`;
      }

      // Combine contexts if different
      if (existing.context !== term.context) {
        existing.context = `${existing.context} | ${term.context}`;
      }

      // Keep source if available
      if (term.source && !existing.source) {
        existing.source = term.source;
      }
    } else {
      // Add new term
      termMap.set(key, { ...term });
    }
  }

  return Array.from(termMap.values());
}
