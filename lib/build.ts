/**
 * Which build this is.
 *
 * Inlined at build time by next.config.ts, so it is identical on the server and
 * in the browser bundle and cannot drift between them.
 *
 * It exists because a stale cache is invisible from the inside. A reviewer —
 * human, or an agent reading the rendered DOM — has no way to know their tab is
 * serving a bundle from three deploys ago, and will report long-fixed bugs with
 * complete confidence. Putting the commit on screen turns "are you sure you're
 * looking at the current build?" into something checkable.
 */
export const BUILD_SHA = process.env.NEXT_PUBLIC_BUILD_SHA || 'local';
export const BUILD_TIME = process.env.NEXT_PUBLIC_BUILD_TIME || 'unknown';
