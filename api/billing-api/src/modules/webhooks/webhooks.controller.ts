import { Controller, Post, Headers, Req, HttpCode, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { WebhooksService } from './webhooks.service';
import { Public } from '@crimfig/shared';

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Public()
  @Post('paystack')
  @HttpCode(200)
  @ApiOperation({ summary: 'Handle Paystack webhook events' })
  async handlePaystack(
    @Headers('x-paystack-signature') signature: string,
    @Req() req: any,
  ) {
    if (!Buffer.isBuffer(req.rawBody)) throw new BadRequestException('Raw webhook body required');
    return this.webhooksService.handlePaystackWebhook(
      req.rawBody.toString('utf8'),
      signature,
    );
  }

  @Public()
  @Post('stripe')
  @HttpCode(200)
  @ApiOperation({ summary: 'Handle Stripe webhook events (multi-provider ready)' })
  async handleStripe(@Headers('stripe-signature') signature: string, @Req() req: any) {
    return { status: 'acknowledged' };
  }
}
