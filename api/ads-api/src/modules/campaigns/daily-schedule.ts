export const SCHEDULE_TIMEZONE = "Africa/Lagos" as const;

export const SCHEDULE_LABEL = "West Africa Time (Africa/Lagos, UTC+01:00)";

export type DailySchedule =
  | {
      version: 1;
      mode: "round_the_clock" | "custom";
      timezone: typeof SCHEDULE_TIMEZONE;
      ranges: { startMinute: number; endMinute: number }[];
    }
  | { version: 1; mode: "inherit" };

export const allDay = (): DailySchedule => ({
  version: 1,
  mode: "round_the_clock",
  timezone: SCHEDULE_TIMEZONE,
  ranges: [],
});

export const inherited = (): DailySchedule => ({ version: 1, mode: "inherit" });

export function validateSchedule(value: unknown, stack = false): DailySchedule {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Choose a valid schedule.");

  const s = value as any;

  if (s.version !== undefined && s.version !== 1)
    throw Error("Unsupported schedule version.");

  if (
    Object.keys(s).some(
      (k) => !["version", "mode", "timezone", "ranges"].includes(k),
    )
  )
    throw Error("Unexpected schedule fields.");

  if (s.mode === "inherit") {
    if (!stack || s.timezone !== undefined || s.ranges !== undefined)
      throw Error("Inherited schedules cannot have ranges or a timezone.");
    return inherited();
  }

  if (
    !["custom", "round_the_clock"].includes(s.mode) ||
    s.timezone !== SCHEDULE_TIMEZONE ||
    !Array.isArray(s.ranges)
  )
    throw Error("Use the Africa/Lagos timezone and a valid schedule mode.");

  if (s.mode === "round_the_clock") {
    if (s.ranges.length) throw Error("Round the Clock has no ranges.");
    return allDay();
  }

  if (!s.ranges.length || s.ranges.length > 10)
    throw Error("Add between 1 and 10 time ranges.");

  const spans: { start: number; end: number }[] = [];

  const ranges = s.ranges.map((r: any) => {
    if (
      !r ||
      typeof r !== "object" ||
      Object.keys(r).some((k) => !["startMinute", "endMinute"].includes(k)) ||
      ![r.startMinute, r.endMinute].every(
        (v) => Number.isInteger(v) && v >= 0 && v <= 1439,
      )
    )
      throw Error("Enter valid start and end hours and minutes.");

    if (r.startMinute === r.endMinute)
      throw Error(
        "Start and end must differ. Use Round the Clock for all-day delivery.",
      );

    if (r.startMinute < r.endMinute)
      spans.push({ start: r.startMinute, end: r.endMinute });
    else {
      spans.push({ start: r.startMinute, end: 1440 });
      if (r.endMinute) spans.push({ start: 0, end: r.endMinute });
    }

    return { startMinute: r.startMinute, endMinute: r.endMinute };
  });

  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++)
    if (spans[i].start < spans[i - 1].end)
      throw Error("Time ranges overlap. Adjust the start or end time.");

  return { version: 1, mode: "custom", timezone: SCHEDULE_TIMEZONE, ranges };
}

export function legacySchedule(value: unknown, stack = false): DailySchedule {
  if (value === null || value === undefined || value === "")
    return stack ? inherited() : allDay();

  const hours = typeof value === "string" ? JSON.parse(value) : value;

  if (
    !Array.isArray(hours) ||
    hours.some((h) => !Number.isInteger(h) || h < 0 || h > 23)
  )
    throw Error("Invalid stored daypart hours.");

  // Stored [] was an explicit unrestricted override in old delivery; null inherited.

  if (!hours.length) return allDay();

  const sorted = [...new Set<number>(hours)].sort((a, b) => a - b);
  if (sorted.length === 24) return allDay();

  const ranges: { startMinute: number; endMinute: number }[] = [];

  for (const h of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && last.endMinute === h * 60)
      last.endMinute = ((h + 1) * 60) % 1440;
    else ranges.push({ startMinute: h * 60, endMinute: ((h + 1) * 60) % 1440 });
  }

  // Legacy lists may have 12 disjoint hours; retain exactly rather than widening.

  return { version: 1, mode: "custom", timezone: SCHEDULE_TIMEZONE, ranges };
}

export function resolvedSchedule(
  campaign: unknown,
  stack: unknown,
  campaignHours?: unknown,
  stackHours?: unknown,
): DailySchedule {
  const c =
    campaign === null || campaign === undefined
      ? legacySchedule(campaignHours)
      : validateSchedule(campaign);

  const s =
    stack === null || stack === undefined
      ? legacySchedule(stackHours, true)
      : validateSchedule(stack, true);

  return s.mode === "inherit" ? c : s;
}

export function scheduleMatches(schedule: DailySchedule, at: Date): boolean {
  if (!Number.isFinite(at.getTime())) return false;

  if (schedule.mode === "inherit")
    throw Error("Resolve stack inheritance before delivery.");

  if (schedule.mode === "round_the_clock") return true;

  const minute = ((at.getUTCHours() + 1) % 24) * 60 + at.getUTCMinutes();

  return schedule.ranges.some((r) =>
    r.startMinute < r.endMinute
      ? minute >= r.startMinute && minute < r.endMinute
      : minute >= r.startMinute || minute < r.endMinute,
  );
}

export function scheduleText(s: DailySchedule): string {
  const t = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

  return s.mode === "inherit"
    ? "Use campaign schedule"
    : s.mode === "round_the_clock"
      ? "Round the Clock"
      : s.ranges
          .map(
            (r) =>
              `${t(r.startMinute)}–${t(r.endMinute)}${r.endMinute < r.startMinute ? " (ends next day)" : ""}`,
          )
          .join(", ");
}
