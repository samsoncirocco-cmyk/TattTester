// Spec 16: validator limits, the contact-detail rule and the travel filters.
import { describe, expect, it } from 'vitest';
import {
  contactDetailIn,
  hasAnyExtras,
  normalizeStoredExtras,
  splitProfilePatch,
  upcomingTravel,
  validateExtrasPatch,
} from './artist-profile-extras';

const trip = (over: Record<string, unknown> = {}) => ({
  city: 'Austin',
  startsOn: '2099-03-04',
  endsOn: '2099-03-09',
  kind: 'guest_spot',
  ...over,
});

describe('validateExtrasPatch', () => {
  it('accepts valid groups and reports which were supplied', () => {
    const r = validateExtrasPatch({
      policies: { deposit: 'Applied to the final price.', cancellation: '48 hours notice to move.' },
      faqs: [{ q: 'Do you do cover-ups?', a: 'Sometimes — send a photo.' }],
      travelDates: [trip({ region: 'TX', note: 'Two days only' })],
    });
    expect(r).toMatchObject({ ok: true, fields: ['policies', 'faqs', 'travelDates'] });
  });

  it('null clears a group; an omitted group is untouched', () => {
    const r = validateExtrasPatch({ faqs: null });
    expect(r).toEqual({ ok: true, value: { faqs: [] }, fields: ['faqs'] });
  });

  it.each([
    ['unknown policy key', { policies: { refunds: 'x' } }],
    ['over-long policy', { policies: { deposit: 'x'.repeat(1001) } }],
    ['nine FAQs', { faqs: Array.from({ length: 9 }, () => ({ q: 'q?', a: 'a' })) }],
    ['over-long question', { faqs: [{ q: 'q'.repeat(141), a: 'a' }] }],
    ['over-long answer', { faqs: [{ q: 'q', a: 'a'.repeat(601) }] }],
    ['blank answer', { faqs: [{ q: 'q', a: '   ' }] }],
    ['unknown FAQ field', { faqs: [{ q: 'q', a: 'a', html: '<b>' }] }],
    ['thirteen travel dates', { travelDates: Array.from({ length: 13 }, () => trip()) }],
    ['reversed range', { travelDates: [trip({ startsOn: '2099-03-09', endsOn: '2099-03-04' })] }],
    ['range over 120 days', { travelDates: [trip({ startsOn: '2099-01-01', endsOn: '2099-06-01' })] }],
    ['bad date', { travelDates: [trip({ startsOn: '2099-02-30' })] }],
    ['bad kind', { travelDates: [trip({ kind: 'vacation' })] }],
    ['URL in a policy', { policies: { deposit: 'Pay at https://venmo.com/me' } }],
    ['bare domain in an answer', { faqs: [{ q: 'Where?', a: 'See inkbynadia.com' }] }],
    ['email in a note', { travelDates: [trip({ note: 'email me@nadia.ink' })] }],
    ['phone in an answer', { faqs: [{ q: 'Call?', a: 'Text (602) 555-0142' }] }],
  ])('rejects %s', (_label, patch) => {
    expect(validateExtrasPatch(patch as never).ok).toBe(false);
  });

  it('a contact-detail refusal says why, in plain words', () => {
    const r = validateExtrasPatch({ policies: { deposit: 'Pay at https://venmo.com/me' } });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/can't include links/);
  });
});

describe('contactDetailIn', () => {
  it('lets dates, prices and plain sentences through', () => {
    expect(contactDetailIn('Books open 2099-03-04. Deposits from $75 to $500.')).toBeNull();
    expect(contactDetailIn('Sessions run 10am–6pm, 4 hours max.')).toBeNull();
    expect(contactDetailIn('Call +44 20 7946 0958')).toBe('phone');
  });
});

describe('splitProfilePatch', () => {
  it('separates the extras groups from scalar profile fields', () => {
    expect(splitProfilePatch({ bio: 'x', faqs: [], instagram: '@a' })).toEqual({
      extras: { faqs: [] },
      scalar: { bio: 'x', instagram: '@a' },
    });
  });
});

describe('travel filters', () => {
  it('drops past trips, keeps in-progress and future ones', () => {
    const travel = [
      trip({ startsOn: '2099-01-01', endsOn: '2099-01-05' }),
      trip({ startsOn: '2099-01-08', endsOn: '2099-01-12' }),
      trip({ startsOn: '2099-02-01', endsOn: '2099-02-02' }),
    ] as never;
    expect(upcomingTravel(travel, '2099-01-10').map((t) => t.startsOn)).toEqual(['2099-01-08', '2099-02-01']);
    expect(upcomingTravel(travel, '2099-01-12')).toHaveLength(2); // ends today is kept
  });

  it('hasAnyExtras ignores a set that is only past travel', () => {
    const e = normalizeStoredExtras({ travelDates: [trip({ startsOn: '2000-01-01', endsOn: '2000-01-02' })] });
    expect(hasAnyExtras(e, '2099-01-01')).toBe(false);
  });

  it('normalizeStoredExtras drops malformed stored groups instead of throwing', () => {
    expect(normalizeStoredExtras({ faqs: 'nope', policies: { deposit: 'ok' } })).toEqual({
      policies: { deposit: 'ok' },
      faqs: [],
      travelDates: [],
    });
  });
});
