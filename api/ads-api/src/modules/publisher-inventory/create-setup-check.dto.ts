import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateSetupCheckDto {
  @IsUUID() requestId: string;
  @IsOptional() @IsString() @MaxLength(256) pagePath?: string;
}

