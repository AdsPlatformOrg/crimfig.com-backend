import {Body,Controller,Get,Post,Param,Req,Query,ParseUUIDPipe} from '@nestjs/common';
import {IsUUID,IsIn,IsArray,IsString,IsOptional,ArrayMaxSize,MaxLength,IsBoolean,IsISO8601} from 'class-validator';
import {AdsRoles} from '../security/ads-staff-grants';
import {EvidenceService} from './evidence.service';
class AssessmentDto {@IsUUID()requestId:string;@IsIn(['eligible','quarantined','invalid'])outcome:'eligible'|'quarantined'|'invalid';@IsArray()@ArrayMaxSize(20)@IsString({each:true})reasonCodes:string[];@IsString()@MaxLength(64)policyVersion:string;@IsOptional()@IsUUID()supersedesId?:string;}
class ControlDto {@IsUUID()requestId:string;@IsIn(['slot','website','promoter','campaign'])targetScope:'slot'|'website'|'promoter'|'campaign';@IsUUID()targetId:string;@IsIn(['SHADOW_SLOT','QUARANTINE_TRAFFIC','PAUSE_PAID_DELIVERY'])action:string;@IsBoolean()active:boolean;@IsString()@MaxLength(64)reasonCode:string;@IsString()@MaxLength(2000)internalNote:string;@IsISO8601()expiresAt:string;}
@AdsRoles('super_admin')
@Controller('admin/ads/evidence')
export class EvidenceController {
  constructor(private readonly evidence:EvidenceService){}
  @Get('checkpoints/:partition') async checkpoint(@Param('partition')partition:string){return {status:'success',data:await this.evidence.checkpoint(partition)};}
  @Get('health') async health(){return {status:'success',data:await this.evidence.health()};}
  @Get('controls/:scope/:targetId') async controls(@Param('scope')scope:string,@Param('targetId',new ParseUUIDPipe())id:string){return {status:'success',data:await this.evidence.controls(scope,id)};}
  @Post('controls') async control(@Body()body:ControlDto,@Req()req:any){return {status:'success',data:await this.evidence.control(req.user.sub,body)};}
  @Get(':id') async detail(@Param('id',new ParseUUIDPipe())id:string){return {status:'success',data:await this.evidence.analyze(id)};}
  @Post(':id/assess') async assess(@Param('id',new ParseUUIDPipe())id:string,@Body()body:AssessmentDto,@Req()req:any){return {status:'success',data:await this.evidence.assess(id,req.user.sub,body)};}
}
