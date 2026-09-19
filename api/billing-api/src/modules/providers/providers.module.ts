import { Module } from '@nestjs/common';
import { PaystackService } from './paystack.service';
import { StripeService } from './stripe.service';

@Module({
  providers: [PaystackService, StripeService],
  exports: [PaystackService, StripeService],
})
export class ProvidersModule {}
