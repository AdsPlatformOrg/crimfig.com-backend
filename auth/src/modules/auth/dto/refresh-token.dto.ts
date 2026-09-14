import { IsString, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class RefreshTokenDto {
  @ApiPropertyOptional({ description: 'Refresh token (optional if crimfig_rt cookie is present)' })
  @IsString()
  @IsOptional()
  refreshToken?: string;
}

