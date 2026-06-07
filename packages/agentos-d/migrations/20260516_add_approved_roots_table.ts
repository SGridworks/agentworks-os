await db.schema.createTable('approved_read_only_roots', (t) => {
  t.integer('id').primaryKey({ autoIncrement: true });
  t.text('root_path').notNull();
  t.text('description');
});

await db.schema.createTable('policy_rule_references', (t) => {
  t.uuid('rule_id').references(() => db.schema.policy_rules.id);
  t.text('reference_type')
    .notNull()
    .check(t => t.reference_type === 'read_only_root');
  t.uuid('reference_id').notNull();
  t.primaryKey({ fields: ['rule_id', 'reference_id'] });
});