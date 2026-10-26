"use client";

import { useEffect } from "react";
import { trackFunnel, type FunnelEvent } from "@/lib/funnel";

/** Fires one funnel event when the screen mounts. */
export default function FunnelBeacon({ event }: { event: FunnelEvent }) {
  useEffect(() => {
    trackFunnel(event);
  }, [event]);
  return null;
}
