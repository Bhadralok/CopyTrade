"use client";

import { useFarcasterUser } from "@/neynar-farcaster-sdk/mini";

/**
 * Hook to access the mini app context, including the current Farcaster user.
 *
 * @returns context object with user data from the Farcaster SDK
 */
export function useMiniAppContext() {
  const { data: user, isLoading, error } = useFarcasterUser();

  const context = {
    user: user ?? null,
  };

  return { context, isLoading, error };
}
