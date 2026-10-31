import {Body,Controller,Get,Post,Param,Headers,UnauthorizedException,ParseUUIDPipe} from '@nestjs/common';
import {IsISO8601,IsUUID,IsString,IsInt,IsObject,IsOptional,Min,MaxLength} from 'class-validator';
import {timingSafeEqual} from 'crypto';
import {Public,FinancialOperation} from '@crimfig/shared';
import {AdOpportunityService} from './ad-opportunity.service';
class ReserveDto {
  @IsISO8601() serveBefore:string;
  @IsUUID('4') opportunityId:string;@IsUUID('4') campaignId:string;@IsUUID('4') creativeId:string;@IsUUID('4') submissionId:string;
  @IsInt() @Min(1) contentRevision:number;@IsUUID('4') promoterId:string;@IsUUID('4') websiteId:string;@IsUUID('4') slotId:string;
  @IsString() @MaxLength(64) policyVersion:string;@IsString() @MaxLength(24) priceNanos:string;@IsInt() @Min(1) clearingPriceMicros:number;
  @IsString() @MaxLength(64) visitorKey:string;@IsString() @MaxLength(16) ipHash:string;@IsObject() decision:Record<string,unknown>;@IsOptional() @IsString() @MaxLength(2048) selectedImageUrl?:string;
}
class IssueDto {@IsString() @MaxLength(64) bindingFingerprint:string;}
class ClaimDto {@IsUUID('4') eventId:string;}
class ReleaseDto {@IsString() @MaxLength(64) reason:string;}
@Public()
@FinancialOperation('escrow')
@Controller('ecosystem/ad-opportunities')
export class AdOpportunityController {
  constructor(private readonly authority:AdOpportunityService){}
  private authorize(key:string|undefined){const expected=process.env.INTERNAL_ECOSYSTEM_KEY;if(!expected||!key||Buffer.byteLength(key)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(key),Buffer.from(expected)))throw new UnauthorizedException('Internal opportunity authorization required');}
  @Post('reserve') async reserve(@Headers('x-internal-key')key:string,@Body()body:ReserveDto){this.authorize(key);return {status:'success',data:await this.authority.reserve(body)};}
  @Get(':id') async read(@Headers('x-internal-key')key:string,@Param('id',new ParseUUIDPipe())id:string){this.authorize(key);return {status:'success',data:await this.authority.read(id)};}
  @Post(':id/issue') async issue(@Headers('x-internal-key')key:string,@Param('id',new ParseUUIDPipe())id:string,@Body()body:IssueDto){this.authorize(key);return {status:'success',data:await this.authority.issue(id,body.bindingFingerprint)};}
  @Post(':id/claim') async claim(@Headers('x-internal-key')key:string,@Param('id',new ParseUUIDPipe())id:string,@Body()body:ClaimDto){this.authorize(key);return {status:'success',data:await this.authority.claim(id,body.eventId)};}
  @Post(':id/reject') async reject(@Headers('x-internal-key')key:string,@Param('id',new ParseUUIDPipe())id:string,@Body()body:ClaimDto){this.authorize(key);return {status:'success',data:await this.authority.reject(id,body.eventId)};}
  @Post(':id/release') async release(@Headers('x-internal-key')key:string,@Param('id',new ParseUUIDPipe())id:string,@Body()body:ReleaseDto){this.authorize(key);return {status:'success',data:await this.authority.release(id,body.reason)};}
}
