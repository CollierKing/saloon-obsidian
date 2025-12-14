import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

// MARK: - Settings Table

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
  updatedAt: text('updated_at'),
});

// MARK: - Approval Actions Table

export const approvalActions = sqliteTable('approval_actions', {
  id: text('id').primaryKey(),
  actionType: text('action_type', {
    enum: [
      'create_term',
      'update_term',
      'add_tag',
      'add_context',
      'trigger_context_search',
      'combine_with'
    ]
  }).notNull(),
  targetTermId: text('target_term_id'),
  termDetails: text('term_details', { mode: 'json' }), // {term, definition, context, source}
  status: text('status', {
    enum: ['pending', 'approved', 'rejected', 'completed']
  }).notNull().default('pending'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at'),
});

// MARK: - Terms Table

export const terms = sqliteTable('terms', {
  termId: text('term_id').primaryKey(),
  term: text('term').notNull(),
  definition: text('definition'), // markdown definition text
  aliases: text('aliases', { mode: 'json' }), // array of aka/fka objects
  context: text('context'), // JSON string: array of {text: string, source: string} objects (or legacy plain text)
  knowledgeTriples: text('knowledge_triples', { mode: 'json' }), // array of {subject, predicate, target}
  tags: text('tags', { mode: 'json' }), // array of tags
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at'),
  lastSyncedAt: text('last_synced_at'), // timestamp of last file<->db sync
});
