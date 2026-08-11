import { Controller, Get, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsNumber, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateCampaignDto {
  @ApiProperty() @IsString() @IsNotEmpty() title!: string;
  @ApiProperty() @IsNumber() @Min(1) budget!: number;
  @ApiProperty() @IsString() @IsNotEmpty() targetAudience!: string;
}

@ApiTags('Ads')
@Controller({ path: 'ads', version: '1' })
export class AdsController {
  @Post('campaigns')
  @ApiOperation({ summary: 'Create new ad campaign' })
  createCampaign(@Body() dto: CreateCampaignDto) {
    return {
      id: 'camp_' + Math.random().toString(36).substring(2, 9),
      ...dto,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
    };
  }

  @Get('campaigns')
  @ApiOperation({ summary: 'List active ad campaigns' })
  getCampaigns() {
    return {
      data: [],
    };
  }
}
