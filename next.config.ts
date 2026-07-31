import type { NextConfig } from 'next';
import { execSync } from 'node:child_process';

/**
 * Which commit is on screen.
 *
 * Reviewers — increasingly agents reading a rendered page rather than people —
 * report what their browser cached, with no way to tell that it is three
 * deploys stale. Two review rounds were spent on bugs that had already been
 * fixed and shipped. Stamping the build into the page makes that detectable in
 * one glance instead of an argument.
 *
 * Vercel sets VERCEL_GIT_COMMIT_SHA on every build. Locally, ask git. Computed
 * here rather than read from a .env file because neither can produce this
 * value, and `env` is what inlines a build-time constant into both the server
 * and the client bundle.
 */
function buildSha(): string {
    if (process.env.VERCEL_GIT_COMMIT_SHA) {
        return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7);
    }
    try {
        return execSync('git rev-parse --short=7 HEAD', {
            stdio: ['ignore', 'pipe', 'ignore'],
        }).toString().trim();
    } catch {
        return 'local';   // a tarball with no git history still has to build
    }
}

const nextConfig: NextConfig = {
    env: {
        NEXT_PUBLIC_BUILD_SHA: buildSha(),
        NEXT_PUBLIC_BUILD_TIME: new Date().toISOString().slice(0, 16).replace('T', ' '),
    },
    turbopack: {
        // Pin the workspace root. Without this Turbopack walks up the tree and
        // can select a stray lockfile outside the project as the root, which
        // changes module resolution and would break the Vercel build.
        root: __dirname,
    },
};

export default nextConfig;
