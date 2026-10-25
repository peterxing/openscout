export type ScheduleSpec =
  | { kind: "times"; days: number[]; times: string[] }
  | { kind: "interval"; minutes: number; offsetMinute: number; workHoursOnly: boolean };

export interface WorkHours {
  start: string;
  end: string;
  days: number[];
}

const DAY_WORDS: Record<string, number> = {
  sun: 0, sunday: 0, sundays: 0,
  mon: 1, monday: 1, mondays: 1,
  tue: 2, tues: 2, tuesday: 2, tuesdays: 2,
  wed: 3, weds: 3, wednesday: 3, wednesdays: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, thursdays: 4,
  fri: 5, friday: 5, fridays: 5,
  sat: 6, saturday: 6, saturdays: 6,
};
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const EXAMPLES =
  'Try phrases like "every weekday at 9am", "every day at 9am, 2pm and 6pm", "every Monday at 8:30am", ' +
  '"every 30 minutes", "every 2 hours at :15" or "every hour during work hours".';

const pad = (n: number) => String(n).padStart(2, "0");

function toHHMM(h: number, m: number, mer?: string): string | null {
  if (mer) {
    const pm = mer.startsWith("p");
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (pm ? 12 : 0);
  }
  if (h > 23 || m > 59) return null;
  return `${pad(h)}:${pad(m)}`;
}

/** Parses Scout-style natural-language schedules. Times are in the computer's local time zone. */
export function parseSchedule(input: string): ScheduleSpec {
  const t = ` ${input.toLowerCase().replace(/[.,;]+/g, (m) => (m.includes(",") ? ", " : " ")).replace(/\s+/g, " ").trim()} `;
  const workHoursOnly = /(work|working|business|office) hours/.test(t);

  let minutes = 0;
  let m: RegExpExecArray | null;
  if ((m = /every (\d+) ?(m|min|mins|minute|minutes)\b/.exec(t))) minutes = Number(m[1]);
  else if ((m = /every (\d+) ?(h|hr|hrs|hour|hours)\b/.exec(t))) minutes = Number(m[1]) * 60;
  else if (/every half(?: an)? hour/.test(t)) minutes = 30;
  else if (/every quarter(?: of an)? hour/.test(t)) minutes = 15;
  else if (/\b(every hour|hourly|each hour)\b/.test(t)) minutes = 60;

  if (minutes) {
    if (minutes < 5) throw new Error("Automations can run at most every 5 minutes.");
    if (minutes > 24 * 60) throw new Error(`Intervals longer than a day aren't supported. ${EXAMPLES}`);
    let offsetMinute = 0;
    const off = /at :(\d{1,2})\b/.exec(t) ?? /at (\d{1,2}) (?:minutes )?past\b/.exec(t);
    if (off) offsetMinute = Math.min(59, Number(off[1]));
    return { kind: "interval", minutes, offsetMinute, workHoursOnly };
  }

  let days: number[] = [];
  if (/\b(weekdays?|work ?days?|business days?)\b/.test(t)) days = [1, 2, 3, 4, 5];
  else if (/\bweekends?\b/.test(t)) days = [0, 6];
  else if (/\b(every ?day|daily|each day|all days)\b/.test(t)) days = [0, 1, 2, 3, 4, 5, 6];
  else {
    const found = new Set<number>();
    for (const word of t.split(/[^a-z]+/)) if (word in DAY_WORDS) found.add(DAY_WORDS[word]);
    days = [...found];
  }

  const times = new Set<string>();
  if (/\bnoon\b|\bmidday\b/.test(t)) times.add("12:00");
  if (/\bmidnight\b/.test(t)) times.add("00:00");
  const timeRe = /\b(\d{1,2})(?::(\d{2}))? ?(am|pm|a m|p m)?\b/g;
  // Only consider numbers in the part after "at" (or the whole string if times are given first, e.g. "9am weekdays").
  const atIdx = t.indexOf(" at ");
  const scope = atIdx >= 0 ? t.slice(atIdx + 4) : t;
  while ((m = timeRe.exec(scope))) {
    const hasMinutes = m[2] !== undefined;
    const mer = m[3]?.replace(" ", "");
    if (!hasMinutes && !mer && atIdx < 0) continue;
    const hhmm = toHHMM(Number(m[1]), Number(m[2] ?? 0), mer);
    if (hhmm) times.add(hhmm);
  }

  if (!times.size) throw new Error(`I couldn't find a time in "${input}". ${EXAMPLES}`);
  if (!days.length) days = [0, 1, 2, 3, 4, 5, 6];
  return { kind: "times", days: [...days].sort(), times: [...times].sort() };
}

function fmtTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const mer = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${pad(m)}${mer}` : `${h12}${mer}`;
}

export function describeSchedule(spec: ScheduleSpec): string {
  if (spec.kind === "interval") {
    const every = spec.minutes % 60 === 0 ? (spec.minutes === 60 ? "every hour" : `every ${spec.minutes / 60} hours`) : `every ${spec.minutes} minutes`;
    return `${every}${spec.offsetMinute ? ` at :${pad(spec.offsetMinute)}` : ""}${spec.workHoursOnly ? " during work hours" : ""}`;
  }
  const d = spec.days.join(",");
  const days =
    d === "0,1,2,3,4,5,6" ? "every day" : d === "1,2,3,4,5" ? "weekdays" : d === "0,6" ? "weekends" : spec.days.map((x) => DAY_LABELS[x]).join(", ");
  const times = spec.times.map(fmtTime);
  const list = times.length > 1 ? `${times.slice(0, -1).join(", ")} and ${times.at(-1)}` : times[0];
  return `${days} at ${list}`;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function inWorkHours(d: Date, wh: WorkHours): boolean {
  if (!wh.days.includes(d.getDay())) return false;
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= minutesOf(wh.start) && mins < minutesOf(wh.end);
}

/** Next local time strictly after `after` that matches the schedule. */
export function nextRun(spec: ScheduleSpec, after: Date, wh: WorkHours): Date | null {
  if (spec.kind === "times") {
    for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
      for (const hhmm of spec.times) {
        const [h, m] = hhmm.split(":").map(Number);
        const c = new Date(after.getFullYear(), after.getMonth(), after.getDate() + dayOffset, h, m, 0, 0);
        if (c > after && spec.days.includes(c.getDay())) return c;
      }
    }
    return null;
  }
  const c = new Date(after);
  c.setSeconds(0, 0);
  for (let i = 0; i < 8 * 24 * 60; i++) {
    c.setMinutes(c.getMinutes() + 1);
    const sinceMidnight = c.getHours() * 60 + c.getMinutes();
    if ((sinceMidnight - spec.offsetMinute) % spec.minutes !== 0) continue;
    if (spec.workHoursOnly && !inWorkHours(c, wh)) continue;
    return new Date(c);
  }
  return null;
}
