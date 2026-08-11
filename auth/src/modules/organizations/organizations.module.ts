import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { OrganizationsService } from './organizations.service';
import { OrganizationsController } from './organizations.controller';
import { config } from '../../config/config';

@Module({
  imports: [JwtModule.register({ secret: config.JWT.ACCESS_SECRET })],
  controllers: [OrganizationsController],
  providers: [OrganizationsService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
