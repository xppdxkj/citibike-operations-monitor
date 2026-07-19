type DatabaseBinding = D1Database;

export async function getCloudflareDatabase(): Promise<DatabaseBinding | null> {
  try {
    const workers = await import("cloudflare:workers");
    return workers.env.DB ?? null;
  } catch {
    // Node hosts such as Render do not expose Cloudflare bindings. Realtime
    // upstream data remains available; only D1-backed history is disabled.
    return null;
  }
}
