import {Body,Controller,Param,Post,Req,ParseUUIDPipe} from '@nestjs/common';
import {IsUUID,IsBoolean,IsString,MinLength,MaxLength} from 'class-validator';
import {AdsRoles} from '../security/ads-staff-grants';
import {CampaignRetentionWorker} from './campaign-retention.worker';
class RetentionHoldDto {@IsUUID()requestId:string;@IsBoolean()active:boolean;@IsString()@MinLength(10)@MaxLength(1000)reason:string;}
@AdsRoles('super_admin')
@Controller('admin/ads/retention')
export class CampaignRetentionController {
  constructor(private readonly retention:CampaignRetentionWorker){}
  @Post('campaigns/:id/hold') async hold(@Param('id',new ParseUUIDPipe())id:string,@Req()req:any,@Body()body:RetentionHoldDto){return {status:'success',data:await this.retention.hold(id,req.user.sub,body)};}
}
