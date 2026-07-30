/**
 * One colour per source system, for every surface that shows provenance.
 *
 * Deliberately not inside shell.tsx: that module is 'use client', and this is
 * imported by the server-rendered tools page too. A plain module keeps it
 * usable from both sides.
 *
 * The values are the CVD-validated categorical set defined in globals.css. The
 * rule that comes with them: brand blue is never a data colour, and Epicor blue
 * is never chrome — so a coloured bar on this app always means "this came from
 * that system", never "this is emphasised".
 */
export const SOURCE_COLOR: Record<string, string> = {
    epicor: 'var(--color-src-epicor)',
    thrive: 'var(--color-src-thrive)',
    ignition: 'var(--color-src-ignition)',
    monday: 'var(--color-src-monday)',
    xref: 'var(--color-src-xref)',
};
