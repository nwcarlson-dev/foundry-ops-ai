import type { Metadata } from 'next';
import { Barlow_Condensed, IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';
import { BUILD_SHA, BUILD_TIME } from '@/lib/build';
import './globals.css';

// Condensed grotesque for signage — the visual language of plant labelling.
const barlow = Barlow_Condensed({
    variable: '--font-barlow',
    subsets: ['latin'],
    weight: ['400', '500', '600', '700'],
});

// IBM Plex was drawn for technical and industrial contexts, which is exactly
// what this is. Mono carries every identifier: job numbers, heats, tag paths.
const plexSans = IBM_Plex_Sans({
    variable: '--font-plex-sans',
    subsets: ['latin'],
    weight: ['400', '500', '600'],
});

const plexMono = IBM_Plex_Mono({
    variable: '--font-plex-mono',
    subsets: ['latin'],
    weight: ['400', '500'],
});

export const metadata: Metadata = {
    title: 'Foundry Ops Copilot',
    description:
        'Ask plain-English questions across four plant systems that share no common keys — ' +
        'Epicor job cost, Thrive melt-deck quality, an Ignition historian, and a monday.com board.',
    /*
     * Which build this is, for anyone who needs to know whether they are
     * looking at a stale cache — `curl -s <url> | grep 'name="build"'`, or the
     * Elements panel. It used to be printed in the header, where it was noise
     * to every actual visitor: a commit hash means nothing to someone reading
     * the app. Here it stays checkable and stops being chrome.
     */
    other: { build: BUILD_SHA, 'build-time': BUILD_TIME },
};

export default function RootLayout({
    children,
}: Readonly<{ children: React.ReactNode }>) {
    return (
        <html
            lang="en"
            className={`${barlow.variable} ${plexSans.variable} ${plexMono.variable} h-full antialiased`}
        >
            <body className="min-h-full flex flex-col">{children}</body>
        </html>
    );
}
