"use client";
// No provider tree is needed: wallet and vault state are zustand stores. Kept
// as the one place to add one if that changes.
export function Providers({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
