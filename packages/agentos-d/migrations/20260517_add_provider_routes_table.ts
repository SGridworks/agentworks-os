export {};

await db.schema.createTable('provider_routes', (t) => {
  t.uuid('id').primaryKey().defaultRandom();
  t.string('provider').notNull();
  t.string('model').nullable();
  t.string('credential_source').notNull();
  t.string('base_url').notNull();
  t.string('auth_mode').notNull();
  t.string('health_check_path').nullable();
  t.integer('priority').notNull();
  t.string('cost_quality_tier').nullable();
  t.timestamp('created_at').default(db.fn.now());
  t.timestamp('updated_at').default(db.fn.now()).onUpdate(db.fn.now());
});

await db.schema.createTable('dispatch_provider_logs', (t) => {
  t.uuid('id').primaryKey().defaultRandom();
  t.uuid('dispatch_queue_id')
    .notNull()
    .references(() => db.schema.dispatch_queue.id);
  t.uuid('provider_route_id')
    .notNull()
    .references(() => db.schema.provider_routes.id);
  t.text('fallback_reason');
  t.text('provider_request_id');
  t.timestamp('created_at').default(db.fn.now());
});
