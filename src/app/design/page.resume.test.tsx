// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const { params, received } = vi.hoisted(() => ({
  params: { current: new URLSearchParams() },
  received: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/components/studio/StudioShell', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/punk/SlashHeadline', () => ({ default: () => <h1 /> }));
vi.mock('next/navigation', () => ({ useSearchParams: () => params.current }));
vi.mock('@/features/design-session', () => ({
  DesignConversation: (props: Record<string, unknown>) => {
    received.push(props);
    return <div data-testid="conversation" />;
  },
}));

import DesignPage from './page';

beforeEach(() => {
  received.length = 0;
});
afterEach(cleanup);

describe('/design entry params (spec 7)', () => {
  it('passes ?ds= through as the session to resume', () => {
    params.current = new URLSearchParams('ds=sess-42');
    render(<DesignPage />);
    expect(received.at(-1)).toEqual({ initialSessionId: 'sess-42' });
  });

  it('lets ds win over prompt, so a reload never re-sends the prompt', () => {
    params.current = new URLSearchParams('ds=sess-42&prompt=a%20fox');
    render(<DesignPage />);
    expect(received.at(-1)).toEqual({ initialSessionId: 'sess-42' });
  });

  it('keeps the prompt deep link unchanged without ds', () => {
    params.current = new URLSearchParams('prompt=a%20fox');
    render(<DesignPage />);
    expect(received.at(-1)).toEqual({ initialPrompt: 'a fox' });
  });
});
