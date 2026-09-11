import postgres from "postgres";

export type PgClient = ReturnType<typeof postgres>;

export function createPgClient(connectionUrl: string): PgClient {
  return postgres(connectionUrl, { max: 10 });
}

export async function pingPg(client: PgClient): Promise<void> {
  await client`select 1`;
}
