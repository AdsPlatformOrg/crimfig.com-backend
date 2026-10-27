# Vendored geography seed data

These files are inputs to `scripts/generate-plan0035-geo-seed.cjs`, which generates
`migrations/0018_plan0035_ad_stacks_geo.sql`. Do not edit the generated migration by hand.

| File | Source | Notes |
|---|---|---|
| `iso3166-countries.json` | https://github.com/lukes/ISO-3166-Countries-with-Regional-Codes (`all/all.json`) | ISO 3166-1 alpha-2 plus UN M49 region/sub-region/intermediate-region labels. |
| `iso3166-subdivisions.json` | https://github.com/olahol/iso-3166-2.json | ISO 3166-2 subdivision codes and names. |

The generated hierarchy uses CrimFig-owned continent and macro-region slugs; country and
subdivision membership follows the source datasets. Review the upstream licenses and
attribution requirements before redistribution. The seed carries a version
(`crimfig-geo-2026.10`) and should only be regenerated together with a deliberate version
change.
