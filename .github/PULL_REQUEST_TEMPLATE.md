## Summary

<!-- What does this change and why? -->

## Checklist

- [ ] `npm test` passes (tests stub `fetch` and run against fixtures — no calls to Apple)
- [ ] The read-only contract holds: no tool changes external state
- [ ] New tools take an explicit date range and a row cap; no raw report dumps
- [ ] `max_periods` stays capped — each period is a separate Reporter call
- [ ] No credential, vendor number, or real report body added to fixtures or docs
- [ ] README tool table updated if tools were added or changed
