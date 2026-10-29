import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { CampaignsService } from "../../../api/ads-api/src/modules/campaigns/campaigns.service";
import { LocationsService } from "../../../api/ads-api/src/modules/locations/locations.service";
import { GooglePlacesProvider } from "../../../api/ads-api/src/modules/locations/providers/google-places.provider";
import { GeoapifyProvider } from "../../../api/ads-api/src/modules/locations/providers/geoapify.provider";
import { ProviderUnavailableError } from "../../../api/ads-api/src/modules/locations/location.types";
import { DeliveryService } from "../../../api/ads-api/src/modules/delivery/delivery.service";
import { UploadsController } from "../../../api/ads-api/src/modules/uploads/uploads.controller";

const GEO_VERSION = "crimfig-geo-2026.10";

function place(overrides: Record<string, any>) {
  return {
    id: "",
    scope: "country",
    parentId: null,
    name: "",
    normalizedName: "",
    countryCode: null,
    subdivisionCode: null,
    latitude: null,
    longitude: null,
    geoVersion: GEO_VERSION,
    sourceProvider: null,
    sourcePlaceId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

const PLACES = [
  place({
    id: "continent:africa",
    scope: "continent",
    name: "Africa",
    normalizedName: "africa",
  }),
  place({
    id: "region:western-africa",
    scope: "region",
    parentId: "continent:africa",
    name: "Western Africa",
    normalizedName: "western africa",
  }),
  place({
    id: "country:NG",
    scope: "country",
    parentId: "region:western-africa",
    name: "Nigeria",
    normalizedName: "nigeria",
    countryCode: "NG",
  }),
  place({
    id: "country:GH",
    scope: "country",
    parentId: "region:western-africa",
    name: "Ghana",
    normalizedName: "ghana",
    countryCode: "GH",
  }),
  place({
    id: "state:NG-LA",
    scope: "state",
    parentId: "country:NG",
    name: "Lagos",
    normalizedName: "lagos",
    countryCode: "NG",
    subdivisionCode: "NG-LA",
  }),
  place({
    id: "city:ikeja",
    scope: "city",
    parentId: "state:NG-LA",
    name: "Ikeja",
    normalizedName: "ikeja",
    countryCode: "NG",
    subdivisionCode: "NG-LA",
  }),
];

function locationsService(): LocationsService {
  const db = {
    select: jest.fn(() => ({ from: jest.fn(async () => PLACES) })),
  } as any;
  return new LocationsService(db);
}

describe("PLAN-0035 ad stacks and geography", () => {
  beforeEach(() => {
    process.env.GEO_TARGETING_ENABLED = "true";
  });
  afterEach(() => {
    delete process.env.GEO_TARGETING_ENABLED;
    delete process.env.CREATIVE_VIDEO_AUTHORING_ENABLED;
    jest.restoreAllMocks();
  });

  it("resolves a continent to its country closure", async () => {
    const service = locationsService();
    const [target] = await service.resolveTargets([
      { placeId: "continent:africa", scope: "continent" },
    ]);
    expect(target.resolvedCountries.sort()).toEqual(["GH", "NG"]);
    expect(target.resolvedSubdivisions).toEqual([]);
    expect(target.resolvedCities).toEqual([]);
  });

  it("resolves a state and city without widening to another state", async () => {
    const service = locationsService();
    const [state] = await service.resolveTargets([
      { placeId: "state:NG-LA", scope: "state" },
    ]);
    expect(state.resolvedCountries).toEqual(["NG"]);
    expect(state.resolvedSubdivisions).toEqual(["NG-LA"]);
    expect(state.resolvedCities).toEqual([]);

    const [city] = await service.resolveTargets([
      { placeId: "city:ikeja", scope: "city" },
    ]);
    expect(city.resolvedCountries).toEqual(["NG"]);
    expect(city.resolvedSubdivisions).toEqual(["NG-LA"]);
    expect(city.resolvedCities).toEqual(["city:ikeja"]);
  });

  it("rejects an unknown place or a scope mismatch", async () => {
    const service = locationsService();
    await expect(
      service.resolveTargets([{ placeId: "country:ZZ", scope: "country" }]),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.resolveTargets([{ placeId: "country:NG", scope: "state" }]),
    ).rejects.toThrow(BadRequestException);
    await expect(service.resolveTargets([])).rejects.toThrow(
      BadRequestException,
    );
  });

  it("browses the seeded hierarchy by parent", async () => {
    const service = locationsService();
    const roots = await service.getHierarchy();
    expect(roots.map((item) => item.id)).toEqual(["continent:africa"]);
    const regions = await service.getHierarchy("continent:africa");
    expect(regions.map((item) => item.id)).toEqual(["region:western-africa"]);
  });

  it("keeps video authoring server-gated and lists only card placements when enabled", () => {
    const service = new CampaignsService(
      {} as any,
      {} as any,
      locationsService(),
    );
    process.env.CREATIVE_VIDEO_AUTHORING_ENABLED = "false";
    expect(service.creationCapabilities()).toEqual({
      geoTargetingEnabled: true,
      videoAuthoringEnabled: false,
      allowedVideoPlacements: [],
      scheduleVersion: 1,
      imagePreparationEnabled: true,
      supportedAdTypes: ["text", "image"],
    });
    process.env.CREATIVE_VIDEO_AUTHORING_ENABLED = "true";
    const enabled = service.creationCapabilities();
    expect(enabled.videoAuthoringEnabled).toBe(true);
    expect(enabled.supportedAdTypes).toEqual(["text", "image", "video"]);
    expect(enabled.allowedVideoPlacements).toEqual([
      "in_content_mid",
      "in_content_end",
      "listing_interstitial",
    ]);
  });

  it("keeps video delivery gated and the embed renderer honest", () => {
    const service = new DeliveryService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    process.env.CREATIVE_VIDEO_AUTHORING_ENABLED = "false";
    expect((service as any).allowedAdTypes("in_content_mid")).toEqual([
      "text",
      "image",
    ]);
    process.env.CREATIVE_VIDEO_AUTHORING_ENABLED = "true";
    expect((service as any).allowedAdTypes("in_content_mid")).toEqual([
      "text",
      "image",
      "video",
    ]);
    expect((service as any).allowedAdTypes("banner_top")).toEqual([
      "text",
      "image",
    ]);

    const script = service.getEmbedScript();
    expect(script).toContain("ad.adType === 'video'");
    expect(script).toContain("/api/v1/delivery/viewability");
    expect(script).toContain("prefers-reduced-motion");
    expect(script).toContain("disablePictureInPicture");
    expect(script).toContain("video.muted = true");
    expect(script).not.toContain("controls");
  });

  it("enforces canonical delivery geography and stack overrides before auction", async () => {
    const targetRows = [
      {
        ownerType: "campaign",
        ownerId: "campaign-1",
        resolvedCountries: '["NG"]',
        resolvedSubdivisions: "[]",
        resolvedCities: "[]",
      },
      {
        ownerType: "stack",
        ownerId: "stack-state",
        resolvedCountries: '["NG"]',
        resolvedSubdivisions: '["NG-LA"]',
        resolvedCities: "[]",
      },
      {
        ownerType: "stack",
        ownerId: "stack-device",
        resolvedCountries: "[]",
        resolvedSubdivisions: "[]",
        resolvedCities: "[]",
      },
    ];
    const db = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({ where: jest.fn(async () => targetRows) })),
      })),
    } as any;
    const service = new DeliveryService(db, {} as any, {} as any, {} as any);
    const base = {
      campaignId: "campaign-1",
      adStackId: "stack-inherit",
      campaignGeoMode: "targeted",
      stackGeoMode: "inherit",
      targetCountries: null,
      targetStates: null,
      targetDevices: null,
      targetHours: null,
    };
    const filter = (candidate: any, geo: any) =>
      (service as any).filterEligibleCandidates(
        [{ ...base, ...candidate }],
        geo,
      );

    expect(await filter({}, { country: "NG" })).toHaveLength(1);
    expect(await filter({}, { country: "GH" })).toHaveLength(0);
    expect(await filter({}, {})).toHaveLength(0);

    const stateCandidate = {
      adStackId: "stack-state",
      stackGeoMode: "targeted",
    };
    expect(
      await filter(stateCandidate, { country: "NG", region: "LA" }),
    ).toHaveLength(1);
    expect(
      await filter(stateCandidate, { country: "NG", region: "AB" }),
    ).toHaveLength(0);

    const globalStack = { adStackId: "stack-global", stackGeoMode: "global" };
    expect(await filter(globalStack, {})).toHaveLength(1);

    const deviceCandidate = {
      adStackId: "stack-device",
      stackGeoMode: "global",
      stackTargetDevices: '["desktop"]',
    };
    expect(await filter(deviceCandidate, { device: "desktop" })).toHaveLength(
      1,
    );
    expect(await filter(deviceCandidate, { device: "android" })).toHaveLength(
      0,
    );

    const stackTargeted = await filter(
      { adStackId: "stack-unknown", stackGeoMode: "targeted" },
      { country: "NG" },
    );
    expect(stackTargeted).toHaveLength(0);
  });

  it("honors byte ranges for public video media", async () => {
    const stream = { pipe: jest.fn() };
    const uploads = {
      getMediaStream: jest.fn(async () => ({
        stream,
        contentType: "video/mp4",
        contentLength: 100,
        totalSize: 1000,
        start: 0,
        end: 99,
        partial: true,
        contentRange: "bytes 0-99/1000",
      })),
    } as any;
    const controller = new UploadsController(uploads);
    const headers: Record<string, string | number> = {};
    const res = {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn((key: string, value: string | number) => {
        headers[key] = value;
        return res;
      }),
      end: jest.fn(),
    } as any;
    await (controller as any).sendMedia(
      { headers: { range: "bytes=0-99" } },
      res,
      "file",
      "public, max-age=31536000, immutable",
    );
    expect(res.status).toHaveBeenCalledWith(206);
    expect(headers["Content-Range"]).toBe("bytes 0-99/1000");
    expect(headers["Accept-Ranges"]).toBe("bytes");
    expect(stream.pipe).toHaveBeenCalledWith(res);

    const invalidRes = {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn((key: string, value: string | number) => {
        headers[key] = value;
        return invalidRes;
      }),
      end: jest.fn(),
    } as any;
    uploads.getMediaStream.mockResolvedValueOnce({
      rangeInvalid: true,
      totalSize: 1000,
    });
    await (controller as any).sendMedia(
      { headers: { range: "bytes=2000-3000" } },
      invalidRes,
      "file",
      "public",
    );
    expect(invalidRes.status).toHaveBeenCalledWith(416);
    expect(invalidRes.setHeader).toHaveBeenCalledWith(
      "Content-Range",
      "bytes */1000",
    );
  });

  it("fails over only on provider unavailability and opens the circuit", async () => {
    const previousFallback = process.env.LOCATION_FALLBACK_ENABLED;
    const previousLimit = process.env.LOCATION_USER_REQUESTS_PER_MINUTE;
    process.env.LOCATION_FALLBACK_ENABLED = "true";
    process.env.LOCATION_USER_REQUESTS_PER_MINUTE = "100";
    try {
      const service = new LocationsService({} as any);
      const google = {
        name: "google",
        isConfigured: () => true,
        autocomplete: jest.fn(async () => {
          throw new ProviderUnavailableError("google", "timeout", "timeout");
        }) as jest.Mock,
        details: jest.fn(),
      };
      const geoapify = {
        name: "geoapify",
        isConfigured: () => true,
        autocomplete: jest.fn(async () => [
          {
            provider: "geoapify",
            providerPlaceId: "geo-1",
            label: "Lagos",
            scopeHint: "city",
            countryCode: "NG",
          },
        ]) as jest.Mock,
        details: jest.fn(),
      };
      (service as any).google = google;
      (service as any).geoapify = geoapify;
      const session = service.createSession("user-1").sessionToken;
      const result = await service.suggest({
        userId: "user-1",
        query: "Lagos",
        scope: "city",
        sessionToken: session,
      });
      expect(result.provider).toBe("geoapify");
      expect(result.suggestions[0].label).toBe("Lagos");

      google.autocomplete.mockClear();
      geoapify.autocomplete.mockClear();
      google.autocomplete.mockResolvedValueOnce([]);
      const empty = await service.suggest({
        userId: "user-1",
        query: "Nowhere",
        scope: "city",
        sessionToken: session,
      });
      expect(empty.suggestions).toEqual([]);
      expect(empty.provider).toBe("google");
      expect(geoapify.autocomplete).not.toHaveBeenCalled();

      google.autocomplete.mockRejectedValue(
        new ProviderUnavailableError("google", "server", "down"),
      );
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await service.suggest({
          userId: "user-1",
          query: "Lagos",
          scope: "city",
          sessionToken: session,
        });
      }
      expect((service as any).circuits.get("google").openUntil).toBeGreaterThan(
        Date.now(),
      );
      google.autocomplete.mockClear();
      await service.suggest({
        userId: "user-1",
        query: "Lagos",
        scope: "city",
        sessionToken: session,
      });
      expect(google.autocomplete).not.toHaveBeenCalled();

      geoapify.isConfigured = () => false;
      google.isConfigured = () => false;
      await expect(
        service.suggest({
          userId: "user-1",
          query: "Lagos",
          scope: "city",
          sessionToken: session,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    } finally {
      if (previousFallback === undefined)
        delete process.env.LOCATION_FALLBACK_ENABLED;
      else process.env.LOCATION_FALLBACK_ENABLED = previousFallback;
      if (previousLimit === undefined)
        delete process.env.LOCATION_USER_REQUESTS_PER_MINUTE;
      else process.env.LOCATION_USER_REQUESTS_PER_MINUTE = previousLimit;
    }
  });

  it("enforces the per-user autocomplete quota", async () => {
    const previousLimit = process.env.LOCATION_USER_REQUESTS_PER_MINUTE;
    process.env.LOCATION_USER_REQUESTS_PER_MINUTE = "1";
    try {
      const service = new LocationsService({} as any);
      const google = {
        name: "google",
        isConfigured: () => true,
        autocomplete: jest.fn(async () => [
          {
            provider: "google",
            providerPlaceId: "g-1",
            label: "Lagos",
            scopeHint: "city",
            countryCode: "NG",
          },
        ]) as jest.Mock,
        details: jest.fn(),
      };
      (service as any).google = google;
      (service as any).geoapify = {
        name: "geoapify",
        isConfigured: () => false,
        autocomplete: jest.fn(),
        details: jest.fn(),
      };
      const session = service.createSession("quota-user").sessionToken;
      await service.suggest({
        userId: "quota-user",
        query: "Lagos",
        scope: "city",
        sessionToken: session,
      });
      await expect(
        service.suggest({
          userId: "quota-user",
          query: "Lagos",
          scope: "city",
          sessionToken: session,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    } finally {
      if (previousLimit === undefined)
        delete process.env.LOCATION_USER_REQUESTS_PER_MINUTE;
      else process.env.LOCATION_USER_REQUESTS_PER_MINUTE = previousLimit;
    }
  });

  it("normalizes Google place details into CrimFig fields", async () => {
    const provider = new GooglePlacesProvider("test-key", 1000);
    jest.spyOn(global, "fetch" as any).mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        id: "google-place",
        displayName: { text: "Ikeja" },
        addressComponents: [
          { types: ["country"], shortText: "NG", longText: "Nigeria" },
          {
            types: ["administrative_area_level_1"],
            shortText: "Lagos",
            longText: "Lagos",
          },
          { types: ["locality"], shortText: "Ikeja", longText: "Ikeja" },
        ],
        location: { latitude: 6.6, longitude: 3.35 },
        types: ["locality"],
      }),
    } as any);
    const details = await provider.details("google-place", "en", "session");
    expect(details).toMatchObject({
      scope: "city",
      countryCode: "NG",
      subdivisionName: "Lagos",
      cityName: "Ikeja",
      latitude: 6.6,
    });
  });

  it("normalizes Geoapify details and rejects unavailable providers", async () => {
    const provider = new GeoapifyProvider("test-key", 1000);
    jest.spyOn(global, "fetch" as any).mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        features: [
          {
            properties: {
              result_type: "city",
              name: "Ikeja",
              country_code: "ng",
              state: "Lagos",
              state_code: "LA",
              city: "Ikeja",
              lat: 6.6,
              lon: 3.35,
            },
          },
        ],
      }),
    } as any);
    const details = await provider.details("geo-place", "en", "session");
    expect(details).toMatchObject({
      scope: "city",
      countryCode: "NG",
      subdivisionName: "Lagos",
      cityName: "Ikeja",
    });

    const unconfigured = new GeoapifyProvider(undefined, 1000);
    await expect(unconfigured.details("x", "en", "s")).rejects.toThrow();
    const unavailable = new GeoapifyProvider("test-key", 1000);
    jest
      .spyOn(global, "fetch" as any)
      .mockResolvedValue({
        status: 503,
        ok: false,
        json: async () => ({}),
      } as any);
    await expect(unavailable.details("x", "en", "s")).rejects.toThrow(
      "Geoapify is unavailable",
    );
  });
});
