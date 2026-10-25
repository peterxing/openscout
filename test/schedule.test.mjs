import assert from "node:assert/strict";
import { test } from "node:test";
import { describeSchedule, nextRun, parseSchedule } from "../dist/server/schedule.js";

const wh = { start: "08:00", end: "18:00", days: [1, 2, 3, 4, 5] };
// Saturday 24 Oct 2026, 09:10 local time.
const from = new Date(2026, 9, 24, 9, 10);
const local = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

const cases = [
  ["every weekday at 9am", "weekdays at 9am", "2026-10-26 09:00"],
  ["every day at 9am, 2pm, and 6pm", "every day at 9am, 2pm and 6pm", "2026-10-24 14:00"],
  ["every Monday at 8:30am", "Mon at 8:30am", "2026-10-26 08:30"],
  ["every 30 minutes", "every 30 minutes", "2026-10-24 09:30"],
  ["every 2 hours at :15", "every 2 hours at :15", "2026-10-24 10:15"],
  ["every hour during work hours", "every hour during work hours", "2026-10-26 08:00"],
  ["weekdays at 17:30", "weekdays at 5:30pm", "2026-10-26 17:30"],
  ["9am every weekday", "weekdays at 9am", "2026-10-26 09:00"],
  ["every mon, wed and fri at 10am", "Mon, Wed, Fri at 10am", "2026-10-26 10:00"],
  ["daily at noon", "every day at 12pm", "2026-10-24 12:00"],
  ["hourly", "every hour", "2026-10-24 10:00"],
];

for (const [input, description, next] of cases) {
  test(`parses "${input}"`, () => {
    const spec = parseSchedule(input);
    assert.equal(describeSchedule(spec), description);
    assert.equal(local(nextRun(spec, from, wh)), next);
  });
}

test("rejects intervals under 5 minutes", () => {
  assert.throws(() => parseSchedule("every 3 minutes"), /at most every 5 minutes/);
});

test("rejects schedules without a time", () => {
  assert.throws(() => parseSchedule("tomorrow sometime"), /couldn't find a time/);
});
