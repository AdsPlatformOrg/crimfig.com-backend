import { Injectable, Inject, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DATABASE_TOKEN } from '../database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '@crimfig/database/schema';
import { billingSavedCards } from '@crimfig/database/schema';
import { and, eq, desc, sql } from 'drizzle-orm';
import { PaystackService } from '../providers/paystack.service';

/** Safe projection: never includes providerToken (the reusable provider authorization). */
const SAFE_CARD_FIELDS = {
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
};

@Injectable()
export class CardsService {
  private readonly logger = new Logger(CardsService.name);

  constructor(
    @Inject(DATABASE_TOKEN)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly paystackService: PaystackService,
  ) {}

  /**
   * List all saved cards for a user (safe fields only)
   */
  async getUserCards(userId: string) {
    return this.db
      .select(SAFE_CARD_FIELDS)
      .from(billingSavedCards)
      .where(eq(billingSavedCards.userId, userId))
      .orderBy(desc(billingSavedCards.isDefault), desc(billingSavedCards.createdAt));
  }

  /**
   * Set a card as user default.
   * One transaction: the user's card rows are locked, so concurrent calls serialize and the
   * user always ends with exactly one default. Returns safe fields only.
   */
  async setDefaultCard(userId: string, cardId: string) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '8s'`);

      const owned = await tx
        .select({ id: billingSavedCards.id })
        .from(billingSavedCards)
        .where(eq(billingSavedCards.userId, userId))
        .for('update');

      if (!owned.some((c) => c.id === cardId)) {
        throw new NotFoundException('Card not found');
      }

      await tx
        .update(billingSavedCards)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(and(eq(billingSavedCards.userId, userId), eq(billingSavedCards.isDefault, true)));

      const [updated] = await tx
        .update(billingSavedCards)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(and(eq(billingSavedCards.id, cardId), eq(billingSavedCards.userId, userId)))
        .returning(SAFE_CARD_FIELDS);

      return updated;
    });
  }

  /**
   * Remove a saved card.
   * The provider authorization is deactivated FIRST; if the provider cannot confirm, the local
   * row is kept (fail closed) so the user can retry and a reusable authorization is never
   * orphaned at the provider. Deletion is owner-bound.
   */
  async deleteCard(userId: string, cardId: string) {
    const [card] = await this.db
      .select({
        id: billingSavedCards.id,
        provider: billingSavedCards.provider,
        providerToken: billingSavedCards.providerToken,
      })
      .from(billingSavedCards)
      .where(and(eq(billingSavedCards.id, cardId), eq(billingSavedCards.userId, userId)))
      .limit(1);

    if (!card) {
      throw new NotFoundException('Card not found');
    }

    if (card.provider === 'paystack') {
      try {
        await this.paystackService.deactivateAuthorization(card.providerToken);
      } catch (err: any) {
        this.logger.error(`Provider authorization deactivation failed for card ${card.id}: ${err?.message}`);
        throw new ServiceUnavailableException(
          'The card could not be removed because the payment provider did not confirm deactivation. Please try again.',
        );
      }
    } else {
      // No deactivation contract implemented for other providers: refuse rather than orphan a token.
      throw new ServiceUnavailableException('Removing this card type is unavailable');
    }

    await this.db
      .delete(billingSavedCards)
      .where(and(eq(billingSavedCards.id, cardId), eq(billingSavedCards.userId, userId)));

    return { message: 'Card successfully removed' };
  }
}
