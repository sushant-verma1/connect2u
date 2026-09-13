import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PgClient } from "../client.js";
import { routingPolicies } from "../schema.js";

export type RoutingPolicyRow = typeof routingPolicies.$inferSelect;

/** R3.1: the active policy for an account, or `null` if it has never set one — the
 * caller (apps/api) falls back to `DEFAULT_ROUTING_POLICY` in that case. */
export async function findActiveRoutingPolicy(
  client: PgClient,
  accountId: string,
): Promise<RoutingPolicyRow | null> {
  const db = drizzle(client);
  const rows = await db
    .select()
    .from(routingPolicies)
    .where(and(eq(routingPolicies.accountId, accountId), eq(routingPolicies.active, true)))
    .limit(1);
  return rows[0] ?? null;
}

/** R3.3: changing routing behaviour is this call, not a deploy. Deactivating the
 * previous active row and inserting the new one happen in one transaction so a reader
 * never observes zero or two active policies for the same account. */
export async function activateRoutingPolicy(
  client: PgClient,
  data: { id: string; accountId: string; policyJson: Record<string, unknown> },
): Promise<RoutingPolicyRow> {
  const db = drizzle(client);
  return db.transaction(async (tx) => {
    const [previous] = await tx
      .select()
      .from(routingPolicies)
      .where(and(eq(routingPolicies.accountId, data.accountId), eq(routingPolicies.active, true)))
      .orderBy(desc(routingPolicies.version))
      .limit(1);

    if (previous) {
      await tx
        .update(routingPolicies)
        .set({ active: false })
        .where(eq(routingPolicies.id, previous.id));
    }

    const version = (previous?.version ?? 0) + 1;
    const rows = await tx
      .insert(routingPolicies)
      .values({
        id: data.id,
        accountId: data.accountId,
        version,
        policyJson: data.policyJson,
        active: true,
      })
      .returning();
    const inserted = rows[0];
    if (!inserted) {
      throw new Error("routing policy insert returned no row");
    }
    return inserted;
  });
}
