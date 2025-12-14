import type { Config } from 'drizzle-kit';

const config: Config = {
  schema: './db/schema.ts',
  out: './db/drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: './saloon.db',
  },
};

export default config;
