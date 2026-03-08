import { pgTable, uuid, text, timestamp, integer, index } from 'drizzle-orm/pg-core';

export const demoRequests = pgTable('demo_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  endpoint: text('endpoint').notNull(), // 'signals' | 'discovery' | 'buzz'
  industry: text('industry'),
  icpText: text('icp_text'),
  ipHash: text('ip_hash').notNull(),
  userAgent: text('user_agent'),
  responseTimeMs: integer('response_time_ms'),
  statusCode: integer('status_code').notNull().default(200),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_demo_requests_ip_hash').on(table.ipHash),
  index('idx_demo_requests_created_at').on(table.createdAt),
  index('idx_demo_requests_endpoint').on(table.endpoint, table.createdAt),
]);
