import { Controller, Get, Header, Post, Patch, Req, Body, Param, Query, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ThrottlerGuard, Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { SupportService } from './support.service';
import { CreateSupportDto, ReadSupportMessagesDto, ReplySupportDto, StaffReplySupportDto, UpdateSupportDto, SupportQueryDto } from './support.dto';
@Controller('auth/support')
@UseGuards(JwtAuthGuard,ThrottlerGuard)
export class SupportController {
 constructor(private readonly support:SupportService) {}
 @Get('tickets') async list(@Req() req:any,@Query() q:SupportQueryDto){return {data:await this.support.list(req.user.sub,q)};}
 @Post('tickets') @Throttle({medium:{limit:10,ttl:60000}}) async create(@Req() req:any,@Body() dto:CreateSupportDto){return {data:await this.support.create(req.user.sub,dto)};}
 @Get('tickets/:id') async detail(@Req() req:any,@Param('id',new ParseUUIDPipe()) id:string){return {data:await this.support.detail(req.user.sub,id)};}
 @Post('tickets/:id/replies') @Throttle({medium:{limit:20,ttl:60000}}) async reply(@Req() req:any,@Param('id',new ParseUUIDPipe()) id:string,@Body() dto:ReplySupportDto){return {data:await this.support.reply(req.user.sub,id,dto)};}
 @Get('admin/tickets') async queue(@Req() req:any,@Query() q:SupportQueryDto){return {data:await this.support.list(req.user.sub,q,true)};}
 @Get('admin/unread') @Header('Cache-Control', 'private, no-store')
 async unread(@Req() req:any){return {data:{count:await this.support.unreadCount(req.user.sub)}};}
 @Post('admin/tickets/:id/read')
 async markRead(@Req() req:any,@Param('id',new ParseUUIDPipe()) id:string,@Body() dto:ReadSupportMessagesDto){
  await this.support.markRead(req.user.sub,id,dto.messageIds);
  return {data:{read:true}};
 }
 @Get('admin/tickets/:id') async inspect(@Req() req:any,@Param('id',new ParseUUIDPipe()) id:string){return {data:await this.support.detail(req.user.sub,id,true)};}
 @Post('admin/tickets/:id/replies') async staffReply(@Req() req:any,@Param('id',new ParseUUIDPipe()) id:string,@Body() dto:StaffReplySupportDto){return {data:await this.support.reply(req.user.sub,id,dto,true,dto.internal)};}
 @Patch('admin/tickets/:id') async update(@Req() req:any,@Param('id',new ParseUUIDPipe()) id:string,@Body() dto:UpdateSupportDto){return {data:await this.support.update(req.user.sub,id,dto)};}
}
