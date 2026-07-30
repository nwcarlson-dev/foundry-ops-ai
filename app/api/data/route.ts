/**
 * Raw source-data browser.
 *
 * The whole argument of this project is that four systems carry the same plant
 * in four incompatible shapes. That claim is only checkable if you can look at
 * the rows, so this endpoint exposes them directly — no model, no tools, no
 * interpretation.
 *
 * Relation names cannot be injected through. The catalogue is read from
 * information_schema and the requested name must match an entry in it before it
 * is ever put into SQL; a value that is not on that list is rejected rather
 * than escaped. Identifiers cannot be bind parameters in Postgres, so an
 * allowlist is the mechanism that makes this safe.
 */
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** The four source systems, in the order they appear everywhere else. */
const SCHEMAS = ['epicor', 'thrive', 'ignition', 'monday', 'xref'] as const;

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

interface Relation {
    schema: string;
    name: string;
    kind: 'table' | 'view';
    rows: number;
}

/**
 * The catalogue is stable — the dataset is seeded from a fixed seed and never
 * written to at runtime — so it is built once per warm process.
 */
let catalogue: Relation[] | null = null;

async function getCatalogue(): Promise<Relation[]> {
    if (catalogue) return catalogue;

    const relations = await query<{
        table_schema: string;
        table_name: string;
        table_type: string;
    }>(
        `SELECT table_schema, table_name, table_type
           FROM information_schema.tables
          WHERE table_schema = ANY($1)
          ORDER BY table_schema, table_name`,
        [SCHEMAS],
    );

    // Exact counts, not reltuples estimates. The dataset is ~76k rows total, so
    // a UNION of counts is cheap, and an approximate row count on a page whose
    // entire purpose is "here are the actual rows" would undercut the point.
    const counts =
        relations.length === 0
            ? []
            : await query<{ relation: string; n: number }>(
                  relations
                      .map(
                          (r) =>
                              `SELECT '${r.table_schema}.${r.table_name}' AS relation, count(*)::int AS n FROM ${r.table_schema}.${r.table_name}`,
                      )
                      .join(' UNION ALL '),
              );

    const byName = new Map(counts.map((c) => [c.relation, c.n]));

    catalogue = relations.map((r) => ({
        schema: r.table_schema,
        name: r.table_name,
        kind: r.table_type === 'VIEW' ? ('view' as const) : ('table' as const),
        rows: byName.get(`${r.table_schema}.${r.table_name}`) ?? 0,
    }));

    return catalogue;
}

export async function GET(request: Request) {
    try {
        const url = new URL(request.url);
        const relation = url.searchParams.get('relation');
        const cat = await getCatalogue();

        // No relation requested: return the catalogue so the UI can render the
        // navigator without a second round trip.
        if (!relation) {
            return Response.json({ relations: cat });
        }

        const match = cat.find((r) => `${r.schema}.${r.name}` === relation);
        if (!match) {
            return Response.json(
                { error: `Unknown relation "${relation}".` },
                { status: 400 },
            );
        }

        const limit = Math.min(
            Math.max(Number(url.searchParams.get('limit')) || DEFAULT_LIMIT, 1),
            MAX_LIMIT,
        );
        const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);

        const columns = await query<{ column_name: string; data_type: string }>(
            `SELECT column_name, data_type
               FROM information_schema.columns
              WHERE table_schema = $1 AND table_name = $2
              ORDER BY ordinal_position`,
            [match.schema, match.name],
        );

        // match.schema and match.name came out of information_schema above, not
        // out of the query string, which is what makes this interpolation safe.
        const rows = await query(
            `SELECT * FROM ${match.schema}.${match.name} LIMIT $1 OFFSET $2`,
            [limit, offset],
        );

        return Response.json({
            relation,
            kind: match.kind,
            total: match.rows,
            limit,
            offset,
            columns: columns.map((c) => ({ name: c.column_name, type: c.data_type })),
            rows,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json({ error: message }, { status: 500 });
    }
}
