/** Whole percent for presentation only. Financial amounts retain their precision. */
export function displayBurnPercent(consumed: number, allocated: number): number {
  if (!Number.isFinite(consumed) || !Number.isFinite(allocated) || consumed <= 0 || allocated <= 0) return 0;
  return Math.min(100, Math.max(1, Math.ceil(Number((consumed / allocated * 100).toFixed(6)))));
}
