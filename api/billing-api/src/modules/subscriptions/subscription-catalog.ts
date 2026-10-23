export interface PlanDefinition {
  id: string;
  name: string;
  appSlug: string;
  monthlyUsd: number;
  annualUsd: number;
  features: string[];
}

export const APP_PLANS: Record<string, PlanDefinition[]> = {
  chat: [
    { id: 'chat_pro', name: 'Chat Pro', appSlug: 'chat', monthlyUsd: 5, annualUsd: 50, features: ['Unlimited storage', 'HD video calls', 'Custom themes'] },
    { id: 'chat_business', name: 'Chat Enterprise', appSlug: 'chat', monthlyUsd: 15, annualUsd: 150, features: ['Admin compliance', 'Data export', 'Dedicated support'] },
  ],
  stream: [
    { id: 'stream_creator', name: 'Stream Creator', appSlug: 'stream', monthlyUsd: 12, annualUsd: 120, features: ['1080p60 streaming', 'Custom RTMP', 'VOD archiving'] },
  ],
  reels: [
    { id: 'reels_pro', name: 'Reels Creator+', appSlug: 'reels', monthlyUsd: 8, annualUsd: 80, features: ['Priority algorithm boost', 'Exclusive badges', 'Creator analytics'] },
  ],
  ads: [
    { id: 'ads_starter', name: 'Advertiser Pro', appSlug: 'ads', monthlyUsd: 20, annualUsd: 200, features: ['Advanced demographic targeting', 'Conversion API', 'Dedicated account manager'] },
  ],
};

