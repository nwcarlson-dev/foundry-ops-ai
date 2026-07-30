import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    turbopack: {
        // Pin the workspace root. Without this Turbopack walks up the tree and
        // can select a stray lockfile outside the project as the root, which
        // changes module resolution and would break the Vercel build.
        root: __dirname,
    },
};

export default nextConfig;
