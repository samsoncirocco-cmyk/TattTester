"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useFavorites, useDemoUser, useDesigns, useBookings } from "@/lib/tattStorage";
import PunkFooter from "@/components/studio/PunkFooter";
import TattTesterWordmark from "@/components/studio/TattTesterWordmark";

type StudioShellProps = {
  children: ReactNode;
  leftSidebar?: ReactNode;
  rightSidebar?: ReactNode;
  /**
   * Render the global PunkFooter at the bottom of the main column.
   * Defaults to true so app routes get the footer too; the Forge can
   * pass `footer={false}` since it has its own sticky bottom chrome.
   */
  footer?: boolean;
  /**
   * Quiet dark (ADR-0032): commitment screens keep the same shell but with
   * the volume down — no halftone/grain, warm-gray hairlines, and no pink
   * in the chrome except the wordmark, which stays the screen's single
   * small pink accent.
   */
  quiet?: boolean;
};

const NAV = [
  // "Design" is the one consumer design entry (ADR-0028): one input, talk
  // or type — a complete prompt takes the fast lane.
  //
  // The Studio is deliberately absent. A nav entry is a cold entry, and the
  // refinery is entered from a picked design (ADR-0038) and is never part of
  // the main journey (ADR-0017). "My Designs" is its door: every saved cut
  // carries "Fix it in the Studio". /studio still answers bookmarks and
  // direct URLs with its picker — it just isn't advertised here.
  { label: "Design", href: "/design" },
  { label: "Artists", href: "/artists" },
  { label: "My Designs", href: "/designs" },
  { label: "Pricing", href: "/pricing" },
];

/** Longest matching href wins, so nested routes light up their own entry
 *  rather than every prefix match. */
function activeHref(pathname: string | null): string | null {
  if (!pathname) return null;
  const matches = NAV.filter(
    (n) => pathname === n.href || pathname.startsWith(n.href + "/")
  );
  if (matches.length === 0) return null;
  return matches.reduce((a, b) => (b.href.length > a.href.length ? b : a)).href;
}

export default function StudioShell({
  children,
  leftSidebar,
  rightSidebar,
  footer = true,
  quiet = false,
}: StudioShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const pathname = usePathname();
  const { favorites, hydrated: favHydrated } = useFavorites();
  const { user, hydrated: userHydrated, signOut } = useDemoUser();
  const { designs, hydrated: designsHydrated } = useDesigns();
  const { bookings, hydrated: bookingsHydrated } = useBookings();

  // Register-dependent chrome classes (ADR-0032).
  const hl = quiet ? "hairline-quiet" : "hairline";
  const hlSoft = quiet ? "hairline-quiet-soft" : "hairline-soft";
  const hov = quiet ? "hover:text-white" : "hover:text-pink";
  const accent = quiet ? "text-quiet" : "text-pink";

  return (
    <div
      className={`${quiet ? "" : "halftone grain "}min-h-screen text-white font-body flex flex-col relative bg-black`}
    >
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-pink focus:px-4 focus:py-3 focus:text-black"
      >
        Skip to content
      </a>
      <header className={`relative z-20 border-b-2 ${hl} bg-black`}>
        <div className="flex items-stretch justify-between">
          <div className="flex items-center px-5 sm:px-8 py-4 gap-6">
            <Link href="/" className="flex items-center">
              <TattTesterWordmark
                className={`font-display text-white text-3xl leading-none tracking-[0.01em] ${quiet ? "" : "glitch"}`}
              />
            </Link>
            <nav aria-label="Primary" className="hidden md:flex items-center gap-5">
              {NAV.map((n) => {
                const active = activeHref(pathname) === n.href;
                return (
                  <Link
                    key={n.href}
                    href={n.href}
                    className={`text-[10px] uppercase tracking-[0.25em] font-body press ${
                      active
                        ? quiet
                          ? "text-white"
                          : "text-pink"
                        : `text-white/70 ${hov}`
                    }`}
                  >
                    {n.label}
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="flex items-stretch">
            {designsHydrated && designs.length > 0 && (
              <Link
                href="/designs"
                aria-label={`${designs.length} saved designs`}
                className={`hidden md:flex items-center px-3 border-l hairline-white text-[10px] uppercase tracking-[0.25em] text-white/70 ${hov} press tabular-nums font-body`}
              >
                ◆&nbsp;{designs.length}
              </Link>
            )}
            {bookingsHydrated && bookings.length > 0 && (
              <Link
                href="/bookings"
                aria-label={`${bookings.length} bookings`}
                className={`hidden md:flex items-center px-3 border-l hairline-white text-[10px] uppercase tracking-[0.25em] text-white/70 ${hov} press tabular-nums font-body`}
              >
                ▣&nbsp;{bookings.length}
              </Link>
            )}
            {favHydrated && favorites.length > 0 && (
              <Link
                href="/artists"
                aria-label={`${favorites.length} favorited artists`}
                className={`hidden md:flex items-center px-4 border-l hairline-white text-[10px] uppercase tracking-[0.25em] ${accent} hover:text-white press tabular-nums font-body`}
              >
                ♥&nbsp;{favorites.length}
              </Link>
            )}
            <div className="hidden md:flex items-stretch relative">
              <button
                onClick={() => setAccountOpen((v) => !v)}
                aria-label="Account"
                aria-expanded={accountOpen}
                className={`px-4 flex items-center justify-center border-l hairline-white text-[10px] uppercase tracking-[0.25em] text-white/70 ${hov} press max-w-[220px]`}
              >
                <span className="truncate">
                  {userHydrated && user
                    ? user.email
                    : userHydrated
                    ? "Sign In"
                    : "Account"}
                </span>
                <span className={`${accent} ml-2`}>▾</span>
              </button>
              {accountOpen && (
                <div className={`absolute right-0 top-full mt-0 w-64 bg-black border-2 ${hl} z-30`}>
                  {userHydrated && user ? (
                    <>
                      <div className={`px-5 py-3 border-b ${hlSoft}`}>
                        <div className="text-[10px] uppercase tracking-[0.25em] text-white/40 font-body">
                          Signed in as
                        </div>
                        <div className={`mt-1 text-[12px] ${accent} font-body truncate`}>
                          {user.name || user.email}
                        </div>
                      </div>
                      <Link
                        href="/designs"
                        onClick={() => setAccountOpen(false)}
                        className={`block px-5 py-3 text-[10px] uppercase tracking-[0.25em] text-white/70 ${hov} hover:bg-white/5 border-b ${hlSoft} font-body`}
                      >
                        My Designs
                      </Link>
                      {/* Signed-in only, but NOT gated on artist status:
                          /console renders the claim pointer for non-artists,
                          which doubles as the artist-acquisition surface. */}
                      <Link
                        href="/console"
                        onClick={() => setAccountOpen(false)}
                        className="block px-5 py-3 text-[10px] uppercase tracking-[0.25em] text-white/70 hover:text-pink hover:bg-white/5 border-b hairline-soft font-body"
                      >
                        Artist console
                      </Link>
                      <Link
                        href="/bookings"
                        onClick={() => setAccountOpen(false)}
                        className={`block px-5 py-3 text-[10px] uppercase tracking-[0.25em] text-white/70 ${hov} hover:bg-white/5 border-b ${hlSoft} font-body`}
                      >
                        My Bookings
                      </Link>
                      <Link
                        href="/settings"
                        onClick={() => setAccountOpen(false)}
                        className={`block px-5 py-3 text-[10px] uppercase tracking-[0.25em] text-white/70 ${hov} hover:bg-white/5 border-b ${hlSoft} font-body`}
                      >
                        Settings
                      </Link>
                      <button
                        onClick={() => {
                          signOut();
                          setAccountOpen(false);
                        }}
                        className={`block w-full text-left px-5 py-3 text-[10px] uppercase tracking-[0.25em] ${accent} ${quiet ? "hover:bg-quiet" : "hover:bg-pink"} hover:text-black font-body`}
                      >
                        Log Out
                      </button>
                    </>
                  ) : (
                    <>
                      <Link
                        href="/login"
                        onClick={() => setAccountOpen(false)}
                        className={`block px-5 py-3 text-[10px] uppercase tracking-[0.25em] text-white/70 ${hov} hover:bg-white/5 border-b ${hlSoft} font-body`}
                      >
                        Log In
                      </Link>
                      <Link
                        href="/signup"
                        onClick={() => setAccountOpen(false)}
                        className={`block px-5 py-3 text-[10px] uppercase tracking-[0.25em] text-white/70 ${hov} hover:bg-white/5 border-b ${hlSoft} font-body`}
                      >
                        Sign Up
                      </Link>
                      <Link
                        href="/settings"
                        onClick={() => setAccountOpen(false)}
                        className={`block px-5 py-3 text-[10px] uppercase tracking-[0.25em] text-white/70 ${hov} hover:bg-white/5 font-body`}
                      >
                        Settings
                      </Link>
                    </>
                  )}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => setMobileOpen((v) => !v)}
              aria-label="Menu"
              aria-expanded={mobileOpen}
              aria-controls="mobile-nav"
              className={`md:hidden w-12 flex items-center justify-center border-l hairline-white text-white/70 ${hov} press`}
            >
              <span className="material-symbols-outlined">
                {mobileOpen ? "close" : "menu"}
              </span>
            </button>
          </div>
        </div>

        {mobileOpen && (
          <nav id="mobile-nav" aria-label="Primary" className={`md:hidden border-t ${hl} bg-black`}>
            {NAV.map((n) => {
              const count =
                n.href === "/designs" && designsHydrated
                  ? designs.length
                  : n.href === "/artists" && favHydrated
                  ? favorites.length
                  : 0;
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  onClick={() => setMobileOpen(false)}
                  className={`flex items-center justify-between px-6 py-4 text-[12px] uppercase tracking-[0.25em] text-white/80 ${hov} border-b ${hlSoft} font-body`}
                >
                  <span>{n.label}</span>
                  {count > 0 && (
                    <span className={`${accent} tabular-nums`}>{count}</span>
                  )}
                </Link>
              );
            })}
            {bookingsHydrated && bookings.length > 0 && (
              <Link
                href="/bookings"
                onClick={() => setMobileOpen(false)}
                className={`flex items-center justify-between px-6 py-4 text-[12px] uppercase tracking-[0.25em] text-white/80 ${hov} border-b ${hlSoft} font-body`}
              >
                <span>My Bookings</span>
                <span className={`${accent} tabular-nums`}>{bookings.length}</span>
              </Link>
            )}
            {userHydrated && user ? (
              <>
                <div className={`px-6 py-3 border-b ${hlSoft}`}>
                  <div className="text-[10px] uppercase tracking-[0.25em] text-white/40 font-body">
                    Signed in as
                  </div>
                  <div className={`mt-1 text-[12px] ${accent} font-body truncate`}>
                    {user.name || user.email}
                  </div>
                </div>
                <Link
                  href="/designs"
                  onClick={() => setMobileOpen(false)}
                  className={`block px-6 py-4 text-[12px] uppercase tracking-[0.25em] text-white/80 ${hov} border-b ${hlSoft} font-body`}
                >
                  My Designs
                </Link>
                {/* Signed-in only, but NOT gated on artist status — see the
                    account dropdown above. */}
                <Link
                  href="/console"
                  onClick={() => setMobileOpen(false)}
                  className="block px-6 py-4 text-[12px] uppercase tracking-[0.25em] text-white/80 hover:text-pink border-b hairline-soft font-body"
                >
                  Artist console
                </Link>
                <Link
                  href="/bookings"
                  onClick={() => setMobileOpen(false)}
                  className={`block px-6 py-4 text-[12px] uppercase tracking-[0.25em] text-white/80 ${hov} border-b ${hlSoft} font-body`}
                >
                  My Bookings
                </Link>
                <Link
                  href="/settings"
                  onClick={() => setMobileOpen(false)}
                  className={`block px-6 py-4 text-[12px] uppercase tracking-[0.25em] text-white/80 ${hov} border-b ${hlSoft} font-body`}
                >
                  Settings
                </Link>
                <button
                  onClick={() => {
                    signOut();
                    setMobileOpen(false);
                  }}
                  className={`block w-full text-left px-6 py-4 text-[12px] uppercase tracking-[0.25em] ${accent} font-body`}
                >
                  Log Out
                </button>
              </>
            ) : (
              <>
                <Link
                  href="/login"
                  onClick={() => setMobileOpen(false)}
                  className={`block px-6 py-4 text-[12px] uppercase tracking-[0.25em] ${accent} border-b ${hlSoft} font-body`}
                >
                  Log In
                </Link>
                <Link
                  href="/signup"
                  onClick={() => setMobileOpen(false)}
                  className={`block px-6 py-4 text-[12px] uppercase tracking-[0.25em] ${accent} font-body`}
                >
                  Sign Up
                </Link>
              </>
            )}
          </nav>
        )}
      </header>

      <div className="flex-1 flex flex-col lg:flex-row min-h-0 relative z-[2]">
        {leftSidebar && (
          <aside className="hidden lg:block w-60 shrink-0 border-r hairline-white bg-black">
            {leftSidebar}
          </aside>
        )}

        <div className="flex-1 min-w-0 overflow-y-auto bg-black flex flex-col">
          <main id="content" tabIndex={-1} className="flex-1 min-w-0 outline-none">
            {children}
          </main>
          {footer && <PunkFooter quiet={quiet} />}
        </div>

        {rightSidebar && (
          <aside className="hidden xl:block w-80 shrink-0 border-l hairline-white relative bg-black">
            {rightSidebar}
          </aside>
        )}
      </div>
    </div>
  );
}
