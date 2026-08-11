import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
  namespace: '/chat',
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(ChatGateway.name);

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('joinRoom')
  handleJoinRoom(
    @MessageBody() data: { roomId: string },
    @ConnectedSocket() client: Socket,
  ) {
    client.join(data.roomId);
    this.logger.log(`Client ${client.id} joined room: ${data.roomId}`);
    return { event: 'joinedRoom', roomId: data.roomId };
  }

  @SubscribeMessage('sendMessage')
  handleMessage(
    @MessageBody() data: { roomId: string; senderId: string; message: string },
  ) {
    const payload = {
      ...data,
      timestamp: new Date().toISOString(),
    };
    this.server.to(data.roomId).emit('newMessage', payload);
    return { status: 'sent', timestamp: payload.timestamp };
  }
}
