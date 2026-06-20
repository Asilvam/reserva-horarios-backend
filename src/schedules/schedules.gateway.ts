import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
  cors: {
    origin: ['https://serviciosasm.cl', 'https://www.serviciosasm.cl', 'http://localhost:5173'],
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: true,
  },
})
export class SchedulesGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(SchedulesGateway.name);

  afterInit(): void {
    this.logger.log('WebSocket Gateway de Horarios inicializado');
  }

  handleConnection(client: Socket): void {
    this.logger.log(`Cliente frontend conectado: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Cliente frontend desconectado: ${client.id}`);
  }

  broadcastSpotsUpdate(scheduleId: string, remaining: number): void {
    this.server.emit('spots_updated', {
      scheduleId,
      remaining,
    });
    this.logger.log(`Broadcast emitido: Horario ${scheduleId} tiene ${remaining} cupos restantes.`);
  }
}
