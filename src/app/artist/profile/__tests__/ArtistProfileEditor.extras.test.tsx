// @vitest-environment jsdom
//
// Spec 16: the profile editor's three new sections load, edit and save in the
// same PATCH, and a server refusal surfaces.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/components/studio/StudioShell', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    loading: false,
    loginWithGoogle: vi.fn(),
    getIdToken: async () => 'token',
  }),
}));
vi.mock('../InstagramPortfolioManager', () => ({ default: () => null }));

import ArtistProfileEditor from '../ArtistProfileEditor';

const PROFILE = {
  id: 'artist_1',
  name: 'Nadia',
  shopName: null,
  bio: null,
  bookingUrl: null,
  city: 'Phoenix',
  state: 'AZ',
  instagram: '@nadia',
};

let patches: Array<Record<string, unknown>>;
let patchResponse: { status: number; body: unknown };

beforeEach(() => {
  patches = [];
  patchResponse = { status: 200, body: { saved: true, profile: PROFILE } };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        patches.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify(patchResponse.body), { status: patchResponse.status });
      }
      return new Response(
        JSON.stringify({
          profile: PROFILE,
          extras: { policies: { deposit: 'Comes off the final price.' }, faqs: [], travelDates: [] },
        }),
        { status: 200 },
      );
    }),
  );
});

describe('ArtistProfileEditor extras (spec 16)', () => {
  it('renders the three sections with the stored values and the empty-state copy', async () => {
    render(<ArtistProfileEditor />);
    expect(await screen.findByRole('heading', { name: 'Policies' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Questions I get asked' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: "Where I'll be" })).toBeTruthy();
    expect((screen.getByLabelText('Deposit') as HTMLTextAreaElement).value).toBe('Comes off the final price.');
    expect(screen.getAllByText('Nothing here yet. Clients see this above the Book button.')).toHaveLength(2);
    expect(screen.getByText(/deposits are refunded in full if you don.t reply in time/)).toBeTruthy();
  });

  it('a save round-trips policies, a new question and new dates in one PATCH', async () => {
    render(<ArtistProfileEditor />);
    await screen.findByRole('heading', { name: 'Policies' });
    fireEvent.change(screen.getByLabelText('Cancelling or rescheduling'), {
      target: { value: '48 hours notice.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add a question' }));
    fireEvent.change(screen.getByLabelText('Question 1'), { target: { value: 'Cover-ups?' } });
    fireEvent.change(screen.getByLabelText('Answer'), { target: { value: 'Sometimes.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add dates' }));
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Austin' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2099-03-04' } });
    fireEvent.change(screen.getByLabelText('Until'), { target: { value: '2099-03-09' } });
    fireEvent.click(screen.getByRole('button', { name: /Save profile/ }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({
      name: 'Nadia',
      policies: { deposit: 'Comes off the final price.', cancellation: '48 hours notice.' },
      faqs: [{ q: 'Cover-ups?', a: 'Sometimes.' }],
      travelDates: [{ city: 'Austin', startsOn: '2099-03-04', endsOn: '2099-03-09', kind: 'guest_spot' }],
    });
    expect(await screen.findByText('Saved')).toBeTruthy();
  });

  it('a validation refusal from the server is shown', async () => {
    patchResponse = { status: 400, body: { error: "Answer 1 can't include links." } };
    render(<ArtistProfileEditor />);
    await screen.findByRole('heading', { name: 'Policies' });
    fireEvent.click(screen.getByRole('button', { name: /Save profile/ }));
    expect(await screen.findByText("Answer 1 can't include links.")).toBeTruthy();
  });
});
