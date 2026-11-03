export type SlotCreativeType = 'text' | 'image' | 'video';
type SlotCreativeTypes = { source: 'default' | 'configured' | 'invalid'; types: SlotCreativeType[] };

export function resolveSlotCreativeTypes(stored: string | null | undefined): SlotCreativeTypes {
  if (stored == null) return { source: 'default', types: ['text', 'image'] };
  try {
    const parsed: unknown = JSON.parse(stored);
    if (Array.isArray(parsed) && parsed.every(type => type === 'text' || type === 'image' || type === 'video')) {
      return { source: 'configured', types: parsed };
    }
  } catch {
    // Invalid stored configuration must not expand eligibility.
  }
  return { source: 'invalid', types: [] };
}
