#!/usr/bin/env node
'use strict';

// This file used to post directly to XFeed and bypass moderation.
// The production workflow deliberately uses the canonical xfeed scraper and
// moderation gate instead, so this legacy entry point must never publish.
console.error(`
This legacy scraper is disabled.

It can bypass the pre-publication moderation gate and must not be used.
Run the "twidouga scraper" GitHub Actions workflow instead. That workflow:
  1. runs xfeed/twidouga-scraper/cache-scraper.cjs
  2. runs xfeed/twidouga-scraper/moderation-gate.py
  3. publishes only the gate's public output
  4. writes uncensored and review candidates to the review queue
`);
process.exitCode = 1;
