import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { billingSavedCards } from '@crimfig/database/schema';
import { and, eq, desc } from 'drizzle-orm';

@Injectable()
export class CardsService {
  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * List all saved cards for a user (safe fields only)
   */
  async getUserCards(userId: string) {
    const cards = await this.db
      .select({
        id: billingSavedCards.id,
        provider: billingSavedCards.provider,
        last4: billingSavedCards.last4,
        expMonth: billingSavedCards.expMonth,
        expYear: billingSavedCards.expYear,
        brand: billingSavedCards.cardBrand,
        cardType: billingSavedCards.cardType,
        bank: billingSavedCards.bank,
        isDefault: billingSavedCards.isDefault,
        createdAt: billingSavedCards.createdAt,
      })
      .from(billingSavedCards)
      .where(eq(billingSavedCards.userId, userId))
      .orderBy(desc(billingSavedCards.isDefault), desc(billingSavedCards.createdAt));

    return cards;
  }

  /**
   * Set a card as user default
   */
  async setDefaultCard(userId: string, cardId: string) {
    const [card] = await this.db
      .select()
      .from(billingSavedCards)
      .where(and(eq(billingSavedCards.id, cardId), eq(billingSavedCards.userId, userId)))
      .limit(1);

    if (!card) {
      throw new NotFoundException('Card not found');
    }

    // Unset all existing defaults
    await this.db
      .update(billingSavedCards)
      .set({ isDefault: false })
      .where(eq(billingSavedCards.userId, userId));

    // Set this card as default
    const [updated] = await this.db
      .update(billingSavedCards)
      .set({ isDefault: true })
      .where(eq(billingSavedCards.id, cardId))
      .returning();

    return updated;
  }

  /**
   * Remove a saved card
   */
  async deleteCard(userId: string, cardId: string) {
    const [card] = await this.db
      .select()
      .from(billingSavedCards)
      .where(and(eq(billingSavedCards.id, cardId), eq(billingSavedCards.userId, userId)))
      .limit(1);

    if (!card) {
      throw new NotFoundException('Card not found');
    }

    await this.db
      .delete(billingSavedCards)
      .where(eq(billingSavedCards.id, cardId));

    return { message: 'Card successfully removed' };
  }
}
