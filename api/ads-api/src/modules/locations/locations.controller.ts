import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { LocationsService } from './locations.service';
import { LocationScope, ProviderName } from './location.types';

const SCOPES: Array<Exclude<LocationScope, 'global'>> = ['continent', 'region', 'country', 'state', 'city'];

export class ResolveLocationDto {
  @IsIn(['google', 'geoapify'])
  provider: ProviderName;

  @IsString()
  @MaxLength(300)
  providerPlaceId: string;

  @IsIn(SCOPES)
  scope: Exclude<LocationScope, 'global'>;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  languageCode?: string;

  @IsString()
  @MaxLength(4096)
  sessionToken: string;
}

@ApiTags('Locations')
@Controller('locations')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Post('session')
  @ApiOperation({ summary: 'Create a short-lived autocomplete session for the signed-in advertiser' })
  createSession(@Req() req: any) {
    return { status: 'success', data: this.locations.createSession(req.user.sub) };
  }

  @Get('hierarchy')
  @ApiOperation({ summary: 'Browse the canonical CrimFig geography hierarchy' })
  async hierarchy(@Query('parentId') parentId?: string) {
    return { status: 'success', data: await this.locations.getHierarchy(parentId) };
  }

  @Get('suggestions')
  @ApiOperation({ summary: 'Provider-neutral location autocomplete (Google primary, Geoapify fallback)' })
  async suggestions(
    @Req() req: any,
    @Query('q') q: string,
    @Query('scope') scope: Exclude<LocationScope, 'global'>,
    @Query('sessionToken') sessionToken: string,
    @Query('parentId') parentId?: string,
    @Query('countryCode') countryCode?: string,
    @Query('languageCode') languageCode?: string,
  ) {
    if (!SCOPES.includes(scope)) {
      return { status: 'error', message: 'A supported location scope is required.' };
    }
    const result = await this.locations.suggest({
      userId: req.user.sub,
      query: q,
      scope,
      parentCanonicalId: parentId,
      countryCode,
      languageCode,
      sessionToken,
    });
    return { status: 'success', data: result };
  }

  @Post('resolve')
  @ApiOperation({ summary: 'Resolve a provider selection into a canonical CrimFig place' })
  async resolve(@Req() req: any, @Body() dto: ResolveLocationDto) {
    const place = await this.locations.resolveSelection({
      userId: req.user.sub,
      provider: dto.provider,
      providerPlaceId: dto.providerPlaceId,
      scope: dto.scope,
      languageCode: dto.languageCode,
      sessionToken: dto.sessionToken,
    });
    return { status: 'success', data: place };
  }

  @Get('place/:canonicalId')
  @ApiOperation({ summary: 'Read a canonical CrimFig place' })
  async place(@Param('canonicalId') canonicalId: string) {
    return { status: 'success', data: await this.locations.getPlace(canonicalId) };
  }
}
