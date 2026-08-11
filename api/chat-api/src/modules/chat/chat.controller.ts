import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SendMessageDto {
  @ApiProperty() @IsString() @IsNotEmpty() roomId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() senderId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() message!: string;
}

@ApiTags('Chat')
@Controller({ path: 'chat', version: '1' })
export class ChatController {
  @Post('messages')
  @ApiOperation({ summary: 'Send chat message via REST fallback' })
  sendMessage(@Body() dto: SendMessageDto) {
    return {
      status: 'sent',
      message: dto.message,
      timestamp: new Date().toISOString(),
    };
  }

  @Get('rooms/:roomId/messages')
  @ApiOperation({ summary: 'Get room message history' })
  getMessages(@Param('roomId') roomId: string) {
    return {
      roomId,
      messages: [],
    };
  }
}
