export function up(db: any) {
  db.schema.createTable('dispatch_attempts', (t) => {
    t.uuid('id').primaryKey().defaultRandom();
    t.uuid('dispatch_queue_id').references(() => db.schema.dispatch_queue.id);
    t.string('provider').notNull();
    t.string('model').nullable();
    t.string('credential_source').notNull();
    t.string('health_state').notNull();
    t.string('failure_class').nullable();
    t.string('fallback_reason').nullable();
    t.uuid('dispatch_id').notNull();
    t.text('log_pointer').nullable();
    t.timestamp('created_at').default(db.fn.now());
  });
}

export function down(db: any) {
  db.schema.dropTable('dispatch_attempts');
}
