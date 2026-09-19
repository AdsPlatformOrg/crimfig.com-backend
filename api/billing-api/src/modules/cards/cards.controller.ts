import { Controller, Get, Post, Delete, Param, Req } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { CardsService } from './cards.service';

@ApiTags('Saved Cards')
@Controller('cards')
export class CardsController {
  constructor(private readonly cardsService: CardsService) {}

  @Get()
  @ApiOperation({ summary: 'List all saved cards for current user' })
  async getCards(@Req() req: any) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const cards = await this.cardsService.getUserCards(userId);
    return { status: 'success', data: cards };
  }

  @Post(':id/default')
  @ApiOperation({ summary: 'Set card as default' })
  async setDefault(@Param('id') cardId: string, @Req() req: any) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const result = await this.cardsService.setDefaultCard(userId, cardId);
    return { status: 'success', data: result };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove a saved card' })
  async deleteCard(@Param('id') cardId: string, @Req() req: any) {
    const userId = req.user?.sub || req.headers['x-user-id'] || 'demo-user-id';
    const result = await this.cardsService.deleteCard(userId, cardId);
    return { status: 'success', data: result };
  }
}
