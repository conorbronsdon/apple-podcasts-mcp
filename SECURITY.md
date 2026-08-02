# Security

This server is read-only: it queries Apple's Reporter service and changes nothing. The things worth protecting are `APPLE_PODCASTS_ACCESS_TOKEN` and `APPLE_PODCASTS_VENDOR_ID`, both read from the environment and never logged. The token is sent only to `reportingitc-reporter.apple.com` over HTTPS.

An Apple Podcasts Connect access token can read every report for every vendor number on the account. Treat it like a password: do not commit it, do not paste it into an issue, and rotate it if it leaks. Tokens expire 180 days after generation regardless.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the **Security** tab on this repo and click **Report a vulnerability**. Do not open a public issue for security problems.

I aim to respond within a week. Credit goes to the reporter in the fix notes unless you prefer otherwise.
