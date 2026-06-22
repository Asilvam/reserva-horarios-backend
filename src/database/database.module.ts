import { Logger, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        uri: configService.get<string>('MONGODB_URI'), // Connection URI for MongoDB
        dbName: configService.get<string>('DBNAME') || 'ReservaHorarios', // Database name
      }),
    }),
  ],
  providers: [Logger],
  exports: [MongooseModule],
})
export class DatabaseModule {
  constructor(private readonly logger: Logger) {}

  onModuleInit() {
    this.logger.log(`Connected to MongoDB database`);
  }
}
