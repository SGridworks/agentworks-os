import { z } from "zod";

/**
 * Canonical contract for "what healthy AWOS local looks like" on this host.
 * Consumed by trust endpoint, doctor, snapshot, restore-plan, and issue-preview.
 *
 * version: bump when fields are removed or semantics change. Additive fields
 * do not require a bump if they are optional.
 */
export const AwosLocalProfileSchema = z.object({
  version: z.literal(1),
  repoRoot: z.string().min(1),
  dataDir: z.string().min(1),
  dbPath: z.string().min(1),
  vaultRoot: z.string().min(1),
  tenantId: z.string().uuid(),
  tenantName: z.string().min(1),
  expectedCompanies: z.array(z.string().min(1)).min(1),
  alwaysKeepIssueIds: z.array(z.string().min(1)),
  ports: z.object({
    admin: z.number().int().positive(),
    api: z.number().int().positive(),
  }),
  launchdLabels: z.array(z.string().min(1)),
  backupDir: z.string().min(1),
  allowedFallbackModel: z.string().min(1).optional(),
  lastKnownGoodSnapshot: z.string().min(1).optional(),
});

export type AwosLocalProfile = z.infer<typeof AwosLocalProfileSchema>;

/**
 * Drift report from validateAgainstRuntime. Each entry is a stable string code
 * downstream agents (trust endpoint, doctor) can switch on.
 */
export type ProfileDriftCode =
  | "dbPath-mismatch"
  | "dataDir-mismatch"
  | "vaultRoot-missing"
  | "repoRoot-mismatch";
