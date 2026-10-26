'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import StudioShell from '@/components/studio/StudioShell';
import { useAuth } from '@/hooks/useAuth';
import InstagramPortfolioManager from './InstagramPortfolioManager';
import ProfileExtrasEditor, { EMPTY_EDITOR_EXTRAS, extrasToPatch } from './ProfileExtrasEditor';
import type { ArtistProfileExtras } from '@/lib/artist-profile-extras';

type Profile = {
  id: string;
  name: string | null;
  shopName: string | null;
  bio: string | null;
  bookingUrl: string | null;
  city: string | null;
  state: string | null;
  instagram: string | null;
};

const EMPTY: Profile = {
  id: '',
  name: '',
  shopName: '',
  bio: '',
  bookingUrl: '',
  city: '',
  state: '',
  instagram: '',
};

export default function ArtistProfileEditor() {
  const { isAuthenticated, loading: authLoading, loginWithGoogle, getIdToken } = useAuth();
  const [profile, setProfile] = useState<Profile>(EMPTY);
  const [extras, setExtras] = useState<ArtistProfileExtras>(EMPTY_EDITOR_EXTRAS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const request = useCallback(
    async (method: 'GET' | 'PATCH', body?: Record<string, unknown>) => {
      const token = await getIdToken();
      if (!token) throw new Error('Sign in to manage your profile.');
      const response = await fetch('/api/v1/artist/profile', {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        profile?: Profile;
        extras?: ArtistProfileExtras | null;
      };
      if (!response.ok) throw new Error(data.error || 'Profile request failed.');
      return data;
    },
    [getIdToken],
  );

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void request('GET')
      .then((data) => {
        if (!cancelled && data.profile) setProfile(data.profile);
        if (!cancelled && data.extras) setExtras(data.extras);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load your profile.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authLoading, isAuthenticated, request]);

  const set = (field: keyof Profile, value: string) => {
    setProfile((current) => ({ ...current, [field]: value }));
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const data = await request('PATCH', {
        name: profile.name,
        shopName: profile.shopName,
        bio: profile.bio,
        bookingUrl: profile.bookingUrl,
        city: profile.city,
        state: profile.state,
        ...extrasToPatch(extras),
      });
      if (data.profile) setProfile(data.profile);
      if (data.extras) setExtras(data.extras);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your profile.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <StudioShell>
      <div className="px-6 md:px-12 pt-6 pb-4 border-b hairline">
        <div className="max-w-3xl mx-auto flex items-center justify-between text-[10px] uppercase tracking-[0.25em] text-white/50 font-body">
          <span><span className="text-pink">●</span>&nbsp;&nbsp;Profile manager</span>
          <Link href="/console" className="hover:text-pink">← Console</Link>
        </div>
      </div>
      <div className="px-6 md:px-12 py-12 md:py-16">
        <div className="max-w-3xl mx-auto">
          <h1 className="font-display text-white text-[40px] md:text-[64px] leading-[0.9]">
            Make it yours<span className="text-pink">.</span>
          </h1>
          <p className="mt-5 max-w-xl font-body text-[13px] leading-[1.6] text-white/60">
            What you save here outranks scraped profile data. Your Instagram handle stays locked
            because it is the identity proof for this profile; contact support to change it.
          </p>

          {!authLoading && !isAuthenticated && (
            <button
              type="button"
              onClick={() => void loginWithGoogle()}
              className="mt-10 tape press px-8 py-4 font-display text-[20px]"
            >
              Log in with Google ▸
            </button>
          )}
          {(authLoading || loading) && (
            <p className="mt-10 font-body text-[11px] uppercase tracking-[0.25em] text-white/50">
              Loading your profile…
            </p>
          )}
          {error && <p className="mt-8 font-body text-[13px] text-pink">{error}</p>}

          {isAuthenticated && !loading && profile.id && (
            <div className="mt-10 space-y-6">
              <Field label="Artist name" value={profile.name ?? ''} onChange={(v) => set('name', v)} />
              <Field label="Shop name" value={profile.shopName ?? ''} onChange={(v) => set('shopName', v)} />
              <div>
                <label className="block font-body text-[10px] uppercase tracking-[0.24em] text-pink">
                  Bio
                </label>
                <textarea
                  value={profile.bio ?? ''}
                  maxLength={1200}
                  rows={6}
                  onChange={(event) => set('bio', event.target.value)}
                  className="mt-2 w-full border hairline bg-black px-4 py-3 font-body text-[14px] text-white"
                />
              </div>
              <div className="grid gap-6 sm:grid-cols-2">
                <Field label="City" value={profile.city ?? ''} onChange={(v) => set('city', v)} />
                <Field label="State" value={profile.state ?? ''} onChange={(v) => set('state', v)} />
              </div>
              <Field
                label="Booking or studio URL"
                value={profile.bookingUrl ?? ''}
                placeholder="https://…"
                onChange={(v) => set('bookingUrl', v)}
              />
              <div className="border hairline p-4">
                <div className="font-body text-[10px] uppercase tracking-[0.24em] text-white/40">
                  Instagram identity anchor
                </div>
                <div className="mt-2 font-body text-[14px] text-white">
                  {profile.instagram || 'No Instagram handle on file'}
                </div>
              </div>
              <InstagramPortfolioManager artistId={profile.id} />
              <ProfileExtrasEditor
                value={extras}
                onChange={(next) => {
                  setExtras(next);
                  setSaved(false);
                }}
              />
              <button
                type="button"
                disabled={saving}
                onClick={() => void save()}
                className="tape press px-8 py-4 font-display text-[20px] disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save profile ▸'}
              </button>
              {saved && (
                <span className="ml-5 font-body text-[11px] uppercase tracking-[0.22em] text-pink">
                  Saved
                </span>
              )}
              <p className="font-body text-[12px] leading-[1.6] text-white/45">
                Your availability already has its own editor in the artist console.
              </p>
            </div>
          )}
        </div>
      </div>
    </StudioShell>
  );
}
function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block font-body text-[10px] uppercase tracking-[0.24em] text-pink">
        {label}
      </label>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full border hairline bg-black px-4 py-3 font-body text-[14px] text-white"
      />
    </div>
  );
}
