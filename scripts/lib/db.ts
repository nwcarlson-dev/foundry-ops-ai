/**
 * Database helpers for the seed script.
 *
 * Uses the Neon serverless driver's Client, which speaks the real Postgres
 * protocol (so multi-statement DDL files with $$-quoted function bodies work)
 * rather than the HTTP `neon()` helper, which is single-statement only.
 */
import { Client, neonConfig } from '@neondatabase/serverless';

// The driver needs a WebSocket implementation. Node 22+ ships a global one.
if (typeof globalThis.WebSocket !== 'undefined') {
    neonConfig.webSocketConstructor = globalThis.WebSocket;
}

export function requireDatabaseUrl(): string {
    const url = process.env.DATABASE_URL;
    if (!url) {
        throw new Error(
            'DATABASE_URL is not set.\n\n' +
            'Create .env.local in the project root with your Neon connection string:\n' +
            '  DATABASE_URL="postgresql://user:pass@host.neon.tech/dbname?sslmode=require"\n\n' +
            'Copy .env.example to get started. Never commit .env.local.',
        );
    }
    return url;
}

export async function connect(): Promise<Client> {
    const client = new Client(requireDatabaseUrl());
    await client.connect();
    return client;
}

/** Postgres caps a statement at 65535 bind parameters. Stay well under it. */
const MAX_PARAMS_PER_STATEMENT = 30000;

/**
 * Multi-row INSERT, chunked so no single statement exceeds the bind-parameter
 * limit. Returns the number of rows inserted.
 */
export async function bulkInsert(
    client: Client,
    table: string,
    columns: string[],
    rows: unknown[][],
): Promise<number> {
    if (rows.length === 0) return 0;

    const rowsPerChunk = Math.max(
        1,
        Math.floor(MAX_PARAMS_PER_STATEMENT / columns.length),
    );
    const columnList = columns.map((c) => `"${c}"`).join(', ');
    let inserted = 0;

    for (let start = 0; start < rows.length; start += rowsPerChunk) {
        const chunk = rows.slice(start, start + rowsPerChunk);
        const params: unknown[] = [];
        const tuples = chunk.map((row) => {
            const placeholders = row.map((value) => {
                params.push(value);
                return `$${params.length}`;
            });
            return `(${placeholders.join(', ')})`;
        });

        await client.query(
            `INSERT INTO ${table} (${columnList}) VALUES ${tuples.join(', ')}`,
            params,
        );
        inserted += chunk.length;
    }

    return inserted;
}

/** ISO timestamp suitable for a timestamptz bind parameter. */
export function ts(date: Date): string {
    return date.toISOString();
}

/** YYYY-MM-DD for a date column. */
export function dateOnly(date: Date): string {
    return date.toISOString().slice(0, 10);
}
