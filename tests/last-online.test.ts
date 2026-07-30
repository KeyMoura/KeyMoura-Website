import assert from "node:assert/strict";
import test from "node:test";

import { formatLastOnline } from "../src/lib/lastOnline.ts";

const now = new Date("2026-07-29T12:00:00Z");

test("formats online, recent, yesterday, old, and missing activity", () => {
  assert.equal(formatLastOnline("2026-07-29T11:55:00Z", now), "Online now");
  assert.equal(formatLastOnline("2026-07-29T11:52:00Z", now), "Last online 8 minutes ago");
  assert.equal(formatLastOnline("2026-07-28T20:00:00Z", now), "Last online yesterday");
  assert.match(formatLastOnline("2026-07-22T12:00:00Z", now) ?? "", /^Last online Jul 22$/);
  assert.equal(formatLastOnline(null, now), null);
  assert.equal(formatLastOnline("not-a-date", now), null);
});
