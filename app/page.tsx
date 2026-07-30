import { Suspense } from 'react';
import Chat from './chat';

// Chat reads ?q= (dashboard cards deep-link into it), and useSearchParams needs
// a Suspense boundary or the whole page opts out of static rendering.
export default function Home() {
    return (
        <Suspense fallback={<div className="flex-1" />}>
            <Chat />
        </Suspense>
    );
}
