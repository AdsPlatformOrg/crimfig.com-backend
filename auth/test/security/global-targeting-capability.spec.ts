import { BadRequestException } from '@nestjs/common';
import { CampaignsService } from '../../../api/ads-api/src/modules/campaigns/campaigns.service';

describe('Global-only campaign authoring', () => {
  afterEach(() => { delete process.env.GEO_TARGETING_ENABLED; });
  const service = () => new CampaignsService({} as any, {} as any, { resolveTargetsByIds: async () => [] } as any);

  it('defaults to advertising Global-only capability without enabling dormant targeting', () => {
    expect(service().creationCapabilities()).toMatchObject({ geoTargetingEnabled: false });
    process.env.GEO_TARGETING_ENABLED = 'true';
    expect(service().creationCapabilities()).toMatchObject({ geoTargetingEnabled: true });
  });

  it('allows Global and inherited stack settings while rejecting location targeting', async () => {
    const s = service() as any;
    await expect(s.resolveGeo('global', [])).resolves.toEqual({ mode: 'global', targets: [] });
    await expect(s.resolveGeo('inherit', [])).resolves.toEqual({ mode: 'inherit', targets: [] });
    await expect(s.resolveGeo('targeted', ['country:NG'])).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects legacy country targeting before creating a campaign or reserving its budget', async () => {
    const db = { transaction: jest.fn() }, escrow = { lockCampaignBudget: jest.fn() };
    const s = new CampaignsService(db as any, escrow as any, { resolveTargetsByIds: async () => [] } as any);
    await expect(s.createCampaign({ advertiserId: 'owner', title: 'Test', budgetUsd: 5, targetCountries: ['NG'] })).rejects.toBeInstanceOf(BadRequestException);
    expect(db.transaction).not.toHaveBeenCalled(); expect(escrow.lockCampaignBudget).not.toHaveBeenCalled();
  });
});
