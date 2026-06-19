import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const allowedOrigins = ['http://localhost:5173', 'http://localhost:3000', 'https://reserva-horarios-front-f55ab4ea7ea8.herokuapp.com', 'https://frontend-reservas.alejandro-silva-m.workers.dev'];
      if (allowedOrigins.indexOf(origin) !== -1 || origin.startsWith('http://localhost:')) {
        callback(null, true);
      } else {
        callback(new Error('Bloqueado por CORS: Origen no permitido'));
      }
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT') || 3000;
  await app.listen(port, '0.0.0.0');
  logger.log(`Application listening on ${port}`);
}
bootstrap();
