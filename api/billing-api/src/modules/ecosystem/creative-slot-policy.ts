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

export function availablePublisherAdTypes(): SlotCreativeType[] {
  const types: SlotCreativeType[] = ['image'];
  if (process.env.ADS_PUBLISHER_TEXT_DELIVERY_ENABLED === 'true') types.push('text');
  if (process.env.CREATIVE_VIDEO_AUTHORING_ENABLED === 'true') types.push('video');
  return types;
}

export function resolveGeneralSlotCreativeTypes(stored: string | null | undefined): SlotCreativeTypes {
  const policy = resolveSlotCreativeTypes(stored);
  const available = availablePublisherAdTypes();
  return { ...policy, types: policy.source === 'default' ? ['image'] : policy.types.filter(type => available.includes(type)) };
}
