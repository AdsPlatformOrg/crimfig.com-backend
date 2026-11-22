import { BadRequestException } from '@nestjs/common';
export const SUPPORT_STAFF_MAIL = Object.freeze({ to: 'support@crimfig.com', bcc: 'jedaccthree@gmail.com' });
export const SUPPORT_ROLES = ['super_admin', 'support_agent'] as const;
export const SUPPORT_STATUSES = ['open', 'in_progress', 'waiting_on_user', 'resolved', 'closed'] as const;
export const SUPPORT_CATEGORIES = ['technical', 'billing', 'campaign_moderation', 'account', 'other'] as const;
const transitions: Record<string, readonly string[]> = {
 open: ['in_progress','waiting_on_user','resolved','closed'], in_progress: ['waiting_on_user','resolved','closed'],
 waiting_on_user: ['in_progress','resolved','closed'], resolved: ['in_progress','closed'], closed: ['in_progress'],
};
export function checkSupportTransition(from: string, to: string) {
 if (from !== to && !transitions[from]?.includes(to)) throw new BadRequestException('Invalid ticket status transition');
}
export function ticketReference(value: string | number) { return '#' + String(value).padStart(7, '0'); }
