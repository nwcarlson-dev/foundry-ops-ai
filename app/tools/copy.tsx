'use client';

/**
 * Copy-to-clipboard for the connect commands.
 *
 * The only client component on the tools page. Everything else there is server
 * rendered from the tool registry, so this stays deliberately small rather than
 * pulling the whole page across the boundary for one button.
 */
import { useState } from 'react';

export function CopyButton({ text, label = 'copy' }: { text: string; label?: string }) {
    const [copied, setCopied] = useState(false);

    return (
        <button
            type="button"
            onClick={async () => {
                try {
                    await navigator.clipboard.writeText(text);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1600);
                } catch {
                    // Clipboard access can be denied (insecure origin, permissions).
                    // The command is on screen either way, so there is nothing to
                    // recover from — just do not claim success.
                }
            }}
            className="sign shrink-0 border border-shell-600 px-2 py-1 text-[0.58rem] transition-colors hover:border-brand-500 hover:text-brand-300"
            style={{ color: copied ? 'var(--color-good)' : 'var(--color-ink-500)' }}
        >
            {copied ? 'copied' : label}
        </button>
    );
}
