# WMS365 Address Validation Provider Review

Last reviewed: 2026-09-02

## Recommendation

Use Geoapify as the first low-cost provider behind a WMS365 provider adapter, while retaining Google as an optional higher-assurance provider. Geoapify supports worldwide autocomplete, structured geocoding, confidence signals, result storage, and 3,000 free credits per day. Its free plan requires Geoapify and OpenStreetMap attribution and permits only limited commercial production use, so WMS365 ownership should confirm the intended production use with Geoapify before activation.

Manual entry remains available when a legitimate dock, rural, new-construction, international, or carrier-confirmed address is not recognized. It requires a reason and explicit confirmation, is signed to the exact company and physical address, and is recorded on the order.

## Comparison

| Provider | Free allowance | Type-ahead | Validation signal | Saved results | Production concern | Decision |
| --- | ---: | --- | --- | --- | --- | --- |
| Geoapify | 3,000 credits/day | Yes | Geocoding confidence and match type | Permitted | Attribution and limited-commercial-use terms | Recommended first provider |
| LocationIQ | 5,000 requests/day | Yes | Address search/autocomplete; not postal deliverability | Confirm terms for stored results | Prominent attribution and 2 requests/second | Supported later if needed |
| Google Maps Platform | 10,000 autocomplete requests and 5,000 Address Validation Pro events/month at no charge before paid tiers | Yes | Strong standardized and deliverability-oriented verdicts | Subject to Google terms | Billing account required; higher overage cost | Keep as premium option |
| Mapbox Address Autofill | 1,000 sessions/month | Yes | Validated autofill results | Search Box results cannot be stored | Saved ship-to library conflicts with result-storage restriction | Do not use for this workflow |
| Radar | No current free tier | Yes | Dedicated address validation | Yes | Annual quoted agreement | Revisit at larger scale |
| Public OSM Nominatim | No charge | No | Geocoding only | Limited by policy | Public service forbids client autocomplete and caps use at 1 request/second | Do not use |

## Official Sources

- Geoapify pricing: https://www.geoapify.com/pricing/
- Geoapify autocomplete documentation: https://apidocs.geoapify.com/docs/geocoding/address-autocomplete/
- Geoapify terms: https://www.geoapify.com/terms-and-conditions/
- LocationIQ pricing: https://locationiq.com/pricing
- LocationIQ autocomplete documentation: https://docs.locationiq.com/docs/autocomplete
- Google Maps Platform pricing: https://developers.google.com/maps/billing-and-pricing/pricing
- Mapbox pricing: https://www.mapbox.com/pricing
- Mapbox Search Box storage restriction: https://www.mapbox.com/search-box
- Radar pricing: https://radar.com/pricing
- OSM Nominatim usage policy: https://operations.osmfoundation.org/policies/nominatim/

## Acceptance Tests

- Suggestions and validation are scoped to the signed-in customer session.
- Provider keys never reach the browser or application logs.
- Saved and verified addresses release normally.
- Provider failures never falsely mark an address verified.
- A manual override requires a reason and confirmation and is bound to the exact customer and address.
- Editing any physical address field invalidates the prior verification or override.
- Missing required fields, invalid Canadian/US postal formats, and obvious placeholder values remain blocked.
- Free-provider attribution is visible beside suggestions as required.
