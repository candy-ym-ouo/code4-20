type AuditInput = {
  actorUserId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  beforeData?: unknown;
  afterData?: unknown;
  requestId?: string;
};

type QueryExecutor = {
  query: (text: string, values?: unknown[]) => Promise<unknown>;
};

export async function writeAudit(client: QueryExecutor, input: AuditInput): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs
      (actor_user_id, action, entity_type, entity_id, before_data, after_data, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.actorUserId,
      input.action,
      input.entityType,
      input.entityId ?? null,
      input.beforeData === undefined ? null : JSON.stringify(input.beforeData),
      input.afterData === undefined ? null : JSON.stringify(input.afterData),
      input.requestId ?? null
    ]
  );
}
