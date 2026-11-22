import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SupportController } from './support.controller';
import { SupportService } from './support.service';
import { SupportWorker } from './support.worker';
@Module({imports:[AuthModule],controllers:[SupportController],providers:[SupportService,SupportWorker]})
export class SupportModule {}
