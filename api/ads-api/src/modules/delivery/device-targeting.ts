/** Broad mobile targeting includes phones and tablets in both selection stages. */
export function matchesDeviceTarget(devices: readonly string[], device?: string): boolean {
  return devices.length === 0 || !!device && (
    devices.includes(device) || devices.includes('mobile') && ['android', 'ios', 'tablet'].includes(device)
  );
}
