import { BadRequestException } from '@nestjs/common';
import { CampaignsService } from '../../../api/ads-api/src/modules/campaigns/campaigns.service';
import { DeliveryService } from '../../../api/ads-api/src/modules/delivery/delivery.service';

const ASSET = {
  id: 'asset-1',
  ownerId: 'advertiser-1',
  status: 'ready',
  mimeType: 'image/jpeg',
  cdnUrl: '/api/v1/uploads/media/asset-1.webp',
  thumbnailUrl: null,
  bytes: 1000,
  sha256: 'a'.repeat(64),
};

function service() {
  return new CampaignsService({} as any, {} as any, {} as any);
}

function txWith(asset: typeof ASSET | null = ASSET) {
  return {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: jest.fn(async () => (asset ? [asset] : [])),
        })),
      })),
    })),
  } as any;
}

describe('PLAN-0038 type-aware creative copy', () => {
  it('accepts an image ad with only an image and destination URL', async () => {
    const result = await (service() as any).validateCreative(txWith(), 'advertiser-1', {
      adType: 'image',
      mediaAssetId: ASSET.id,
      destinationUrl: 'https://example.com/product',
    });
    expect(result).toMatchObject({
      adType: 'image',
      headline: null,
      bodyText: null,
      ctaText: null,
      destinationUrl: 'https://example.com/product',
      imageUrl: ASSET.cdnUrl,
    });
  });

  it('keeps a headline required for text ads and defaults their CTA', async () => {
    await expect((service() as any).validateCreative(txWith(), 'advertiser-1', {
      adType: 'text',
      destinationUrl: 'https://example.com/offer',
    })).rejects.toBeInstanceOf(BadRequestException);

    const result = await (service() as any).validateCreative(txWith(), 'advertiser-1', {
      adType: 'text',
      headline: 'A clear offer',
      destinationUrl: 'https://example.com/offer',
    });
    expect(result.headline).toBe('A clear offer');
    expect(result.ctaText).toBe('Learn More');
  });

  it('accepts optional copy on an image ad', async () => {
    const result = await (service() as any).validateCreative(txWith(), 'advertiser-1', {
      adType: 'image',
      mediaAssetId: ASSET.id,
      headline: 'Optional context',
      bodyText: 'Supporting copy',
      ctaText: 'Shop now',
      destinationUrl: 'https://example.com/product',
    });
    expect(result).toMatchObject({ headline: 'Optional context', ctaText: 'Shop now' });
  });

  it('rejects an image without an owned, ready asset', async () => {
    await expect((service() as any).validateCreative(txWith(null), 'advertiser-1', {
      adType: 'image',
      mediaAssetId: ASSET.id,
      destinationUrl: 'https://example.com/product',
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('renders image-only ads with a clickable image and no invented CTA', () => {
    const script = new DeliveryService({} as any, {} as any, {} as any, {} as any).getEmbedScript();
    expect(script).toContain('if (ad.headline)');
    expect(script).toContain('imgLink');
    expect(script).toContain('if (ad.ctaText && ad.clickUrl');
    expect(script).not.toContain("(ad.ctaText || 'Learn More')");
  });

  it('rejects unsafe destination URLs for every type', async () => {
    await expect((service() as any).validateCreative(txWith(), 'advertiser-1', {
      adType: 'image',
      mediaAssetId: ASSET.id,
      destinationUrl: 'javascript:alert(1)',
    })).rejects.toBeInstanceOf(BadRequestException);
  });
});
