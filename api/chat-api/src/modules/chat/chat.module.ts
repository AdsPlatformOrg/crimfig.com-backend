import { Module } from '@nestjs/common';
import { ChatGateway } from './chat.gateway';
import { ChatController } from './chat.controller';

@Module({
  controllers: [ChatController],
  providers: [ChatGateway],
  exports: [ChatGateway],
})
export class ChatModule {}
