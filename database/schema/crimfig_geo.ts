import {
  pgTable,
  uuid,
  varchar,
  text,
  doublePrecision,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * crimfig_geo_places
 *
 * Versioned, provider-neutral geography hierarchy. Campaign targeting stores
 * these canonical IDs, never a provider place ID as its authority.
 *
 * scope: continent | region | country | state | city
 */
export const crimfigGeoPlaces = pgTable(
  'crimfig_geo_places',
  {
    id: varchar('id', { length: 160 }).primaryKey(),
    scope: varchar('scope', { length: 16 }).notNull(),
    parentId: varchar('parent_id', { length: 160 }),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    countryCode: varchar('country_code', { length: 2 }),
    subdivisionCode: varchar('subdivision_code', { length: 16 }),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    geoVersion: varchar('geo_version', { length: 40 }).notNull(),
    sourceProvider: varchar('source_provider', { length: 20 }),
    sourcePlaceId: text('source_place_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('crimfig_geo_places_scope_idx').on(t.scope),
    index('crimfig_geo_places_parent_idx').on(t.parentId),
    index('crimfig_geo_places_country_idx').on(t.countryCode),
    uniqueIndex('crimfig_geo_places_city_name_uq')
      .on(t.parentId, t.normalizedName, t.geoVersion)
      .where(sql`scope = 'city'`),
  ],
);

/**
 * crimfig_geo_targets
 *
 * Polymorphic targeting rows for a campaign or a stack override. `ownerType`
 * is `campaign` or `stack`; ownership is enforced by the service layer because
 * campaigns and stacks live in different tables.
 *
 * resolvedCountries / resolvedSubdivisions are immutable JSON snapshots of the
 * descendant closure at save time, evaluated against geoVersion. This prevents
 * a hierarchy update from silently widening or changing live targeting.
 */
export const crimfigGeoTargets = pgTable(
  'crimfig_geo_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerType: varchar('owner_type', { length: 16 }).notNull(),
    ownerId: uuid('owner_id').notNull(),
    placeId: varchar('place_id', { length: 160 }).notNull(),
    scope: varchar('scope', { length: 16 }).notNull(),
    geoVersion: varchar('geo_version', { length: 40 }).notNull(),
    resolvedCountries: text('resolved_countries').notNull().default('[]'),
    resolvedSubdivisions: text('resolved_subdivisions').notNull().default('[]'),
    resolvedCities: text('resolved_cities').notNull().default('[]'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('crimfig_geo_targets_owner_place_uq').on(t.ownerType, t.ownerId, t.placeId),
    index('crimfig_geo_targets_owner_idx').on(t.ownerType, t.ownerId),
  ],
);

export type CrimfigGeoPlace = typeof crimfigGeoPlaces.$inferSelect;
export type NewCrimfigGeoPlace = typeof crimfigGeoPlaces.$inferInsert;
export type CrimfigGeoTarget = typeof crimfigGeoTargets.$inferSelect;
export type NewCrimfigGeoTarget = typeof crimfigGeoTargets.$inferInsert;
