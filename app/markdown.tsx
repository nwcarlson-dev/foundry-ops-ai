/**
 * A deliberately small markdown renderer for assistant answers.
 *
 * Hand-rolled rather than pulling in a library for two reasons: it avoids a
 * dependency for the handful of constructs the model actually emits, and it
 * renders to React elements rather than HTML, so model output can never inject
 * markup. Supports headings, bold, inline code, bullet lists, and tables —
 * which is the full vocabulary the system prompt asks for.
 */
import { Fragment, type ReactNode } from 'react';

/** Inline: **bold** and `code`, applied in one pass. */
function inline(text: string, keyPrefix: string): ReactNode[] {
    const out: ReactNode[] = [];
    const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let last = 0;
    let match: RegExpExecArray | null;
    let i = 0;

    while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) out.push(text.slice(last, match.index));
        const token = match[0];
        if (token.startsWith('**')) {
            out.push(<strong key={`${keyPrefix}-b${i++}`}>{token.slice(2, -2)}</strong>);
        } else {
            out.push(<code key={`${keyPrefix}-c${i++}`}>{token.slice(1, -1)}</code>);
        }
        last = match.index + token.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
}

const splitRow = (line: string) =>
    line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());

const isDivider = (line: string) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');

export function Markdown({ text }: { text: string }) {
    const lines = text.split('\n');
    const blocks: ReactNode[] = [];
    let paragraph: string[] = [];
    let bullets: string[] = [];
    let key = 0;

    const flushParagraph = () => {
        if (paragraph.length === 0) return;
        const joined = paragraph.join(' ');
        blocks.push(<p key={`p${key++}`}>{inline(joined, `p${key}`)}</p>);
        paragraph = [];
    };

    const flushBullets = () => {
        if (bullets.length === 0) return;
        blocks.push(
            <ul key={`u${key++}`}>
                {bullets.map((b, i) => (
                    <li key={i}>{inline(b, `u${key}-${i}`)}</li>
                ))}
            </ul>,
        );
        bullets = [];
    };

    const flushAll = () => { flushParagraph(); flushBullets(); };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (trimmed === '') { flushAll(); continue; }

        // Table: a header row followed by a divider row.
        if (trimmed.includes('|') && i + 1 < lines.length && isDivider(lines[i + 1])) {
            flushAll();
            const header = splitRow(trimmed);
            const rows: string[][] = [];
            i += 2;
            while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
                rows.push(splitRow(lines[i]));
                i++;
            }
            i--;
            blocks.push(
                <div key={`t${key++}`} className="overflow-x-auto">
                    <table>
                        <thead>
                            <tr>{header.map((h, hi) => <th key={hi}>{inline(h, `th${hi}`)}</th>)}</tr>
                        </thead>
                        <tbody>
                            {rows.map((r, ri) => (
                                <tr key={ri}>
                                    {r.map((c, ci) => <td key={ci}>{inline(c, `td${ri}-${ci}`)}</td>)}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>,
            );
            continue;
        }

        const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
        if (heading) {
            flushAll();
            blocks.push(<h3 key={`h${key++}`}>{inline(heading[2], `h${key}`)}</h3>);
            continue;
        }

        const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
        if (bullet) {
            flushParagraph();
            bullets.push(bullet[1]);
            continue;
        }

        flushBullets();
        paragraph.push(trimmed);
    }

    flushAll();
    return <Fragment>{blocks}</Fragment>;
}
