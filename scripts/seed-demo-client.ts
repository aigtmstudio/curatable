/**
 * Seed script: creates the demo client, ICPs, and signal hypotheses.
 *
 * Usage:
 *   npx tsx scripts/seed-demo-client.ts
 *
 * Idempotent — checks for existing "demo" client slug before creating.
 * Prints the DEMO_CLIENT_ID to set in .env.
 */
import { initDb, closeDb, getDb, schema } from '../src/db/index.js';
import { config } from '../src/config/index.js';
import { eq } from 'drizzle-orm';
import { DEMO_INDUSTRIES } from '../src/services/demo/industry-config.js';

async function main() {
  initDb(config.databaseUrl);
  const db = getDb();

  // 1. Check for existing demo client
  const [existing] = await db
    .select()
    .from(schema.clients)
    .where(eq(schema.clients.slug, 'demo'))
    .limit(1);

  let clientId: string;

  if (existing) {
    clientId = existing.id;
    console.log(`Demo client already exists: ${clientId}`);

    // Update credit balance to ensure it's high enough
    await db
      .update(schema.clients)
      .set({
        creditBalance: '999999',
        isActive: true,
        updatedAt: new Date(),
      })
      .where(eq(schema.clients.id, clientId));
    console.log('Credit balance refreshed to 999,999');
  } else {
    // 2. Create demo client
    const [client] = await db
      .insert(schema.clients)
      .values({
        name: 'Curatable Demo',
        slug: 'demo',
        industry: 'Technology',
        website: 'https://curatable.io',
        notes: 'Auto-created demo client for website live demo feature. Do not delete.',
        creditBalance: '999999',
        creditMarginPercent: '0', // No margin on demo usage
        settings: { currency: 'GBP' },
      })
      .returning();
    clientId = client.id;
    console.log(`Created demo client: ${clientId}`);
  }

  // 3. Create ICPs (one per industry) — skip if they already exist
  let icpsCreated = 0;
  const icpIds: Record<string, string> = {};

  for (const [slug, industryConfig] of Object.entries(DEMO_INDUSTRIES)) {
    const icpName = `Demo ICP — ${industryConfig.label}`;

    const [existingIcp] = await db
      .select()
      .from(schema.icps)
      .where(
        eq(schema.icps.clientId, clientId),
      )
      .limit(100); // Get all ICPs for this client

    // Check if this specific ICP already exists
    const allIcps = await db
      .select()
      .from(schema.icps)
      .where(eq(schema.icps.clientId, clientId));

    const matchingIcp = allIcps.find(i => i.name === icpName);

    if (matchingIcp) {
      icpIds[slug] = matchingIcp.id;
      continue;
    }

    const [icp] = await db
      .insert(schema.icps)
      .values({
        clientId,
        name: icpName,
        description: `Demo ICP for ${industryConfig.label} industry signals and intelligence`,
        naturalLanguageInput: `Companies in the ${industryConfig.label} sector, focusing on ${industryConfig.segments.slice(0, 3).join(', ')}`,
        filters: {
          industries: [industryConfig.label],
          keywords: industryConfig.segments,
        },
        socialKeywords: industryConfig.segments.slice(0, 5),
      })
      .returning();

    icpIds[slug] = icp.id;
    icpsCreated++;
  }
  console.log(`ICPs: ${icpsCreated} created, ${Object.keys(DEMO_INDUSTRIES).length - icpsCreated} already existed`);

  // 4. Create signal hypotheses (4 per industry) — skip duplicates
  let hypothesesCreated = 0;

  // Load existing hypotheses for deduplication
  const existingHypotheses = await db
    .select()
    .from(schema.signalHypotheses)
    .where(eq(schema.signalHypotheses.clientId, clientId));

  const existingTexts = new Set(existingHypotheses.map(h => h.hypothesis));

  for (const [slug, industryConfig] of Object.entries(DEMO_INDUSTRIES)) {
    const icpId = icpIds[slug];

    for (const seed of industryConfig.hypotheses) {
      if (existingTexts.has(seed.hypothesis)) continue;

      await db
        .insert(schema.signalHypotheses)
        .values({
          clientId,
          icpId: icpId ?? null,
          hypothesis: seed.hypothesis,
          signalLevel: seed.signalLevel,
          signalCategory: seed.signalCategory,
          monitoringSources: seed.monitoringSources,
          affectedSegments: seed.affectedSegments,
          priority: seed.priority,
          status: 'active',
          validatedBy: 'human_created',
        });

      hypothesesCreated++;
    }
  }
  console.log(`Hypotheses: ${hypothesesCreated} created, ${existingHypotheses.length} already existed`);

  // 5. Summary
  console.log('\n=== Demo Client Setup Complete ===');
  console.log(`DEMO_CLIENT_ID=${clientId}`);
  console.log(`\nAdd this to your .env file:`);
  console.log(`DEMO_CLIENT_ID=${clientId}`);
  console.log(`DEMO_DAILY_LIMIT=100`);
  console.log(`DEMO_CREDIT_BYPASS=true`);

  await closeDb();
}

main().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
