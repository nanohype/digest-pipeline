import { Pool } from 'pg';

/**
 * Small factory so tests and the composition root can both build a pool
 * against whatever connection string is in scope without re-parsing env
 * in two places.
 */
export function createDbPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}
