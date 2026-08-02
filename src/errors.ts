/**
 * Typed error hierarchy for the Apple Podcasts Connect Reporter protocol.
 *
 * Reporter is not REST. It answers almost everything with HTTP 200 or a 4xx
 * whose body carries the real signal: a numeric Reporter error code plus a
 * message. `ReporterClient` funnels both HTTP failures and in-body Reporter
 * errors through `mapReporterError` so callers can branch on error type with
 * `instanceof` instead of string-matching Apple's copy.
 *
 * Codes are from Apple's Reporter User Guide (help.apple.com/itc/podcastsreporterguide).
 */

export class ReporterError extends Error {
  constructor(
    /** Apple's numeric Reporter code, or 0 when the failure was transport-level. */
    public code: number,
    message: string,
    /** The Reporter command that failed, e.g. "Sales.getReport". */
    public command: string,
  ) {
    super(`Apple Reporter error (${code}) on ${command}: ${message}`);
    this.name = "ReporterError";
  }
}

/** Code 123 — the token aged out. Tokens live 180 days; this is the common one. */
export class TokenExpiredError extends ReporterError {
  constructor(command: string) {
    super(
      123,
      "Access token is expired. Reporter tokens last 180 days. Issue a new one with Reporter's generateToken command and update APPLE_PODCASTS_ACCESS_TOKEN. Note that Apple allows one active token per Apple Account, so rotating breaks anything else on the account that uses Reporter. See the token rotation section of the README.",
      command,
    );
    this.name = "TokenExpiredError";
  }
}

/** Codes 124, 125, 132 — token malformed, rejected, or not supplied at all. */
export class TokenInvalidError extends ReporterError {
  constructor(command: string, code = 124) {
    super(
      code,
      "Access token is missing, malformed, or rejected. Set APPLE_PODCASTS_ACCESS_TOKEN to a token issued by Reporter's generateToken command. Copy the whole string; it is long and easy to truncate.",
      command,
    );
    this.name = "TokenInvalidError";
  }
}

/** Codes 200, 300 — vendor number is not one this token can read. */
export class VendorError extends ReporterError {
  constructor(command: string, vendorId: string, code = 200) {
    super(
      code,
      `Invalid vendor number "${vendorId}". It is digits only, no leading letter — the account UUID shown under Podcasts Connect > Account > Details is a different identifier and will not work. Vendor numbers exist only for Apple Podcasters Program members. Run the apple_podcasts_check_access tool to list the vendor numbers this token can read.`,
      command,
    );
    this.name = "VendorError";
  }
}

/**
 * Codes 209, 211, 213 — the request was valid but Apple has nothing for that
 * date. Routine, not a fault: reports lag ~1-2 days and gaps are normal.
 */
export class NoDataError extends ReporterError {
  constructor(command: string, date: string, code = 213) {
    super(
      code,
      `No report available for ${date}. Apple publishes listening reports on a lag of roughly one to two days, and emits nothing at all for a period with no activity. Try an earlier date, or a Weekly/Monthly period.`,
      command,
    );
    this.name = "NoDataError";
  }
}

/**
 * Codes 214, 215 — the token can read several Apple accounts and Reporter will
 * not guess which one, or the account number supplied is not one of them.
 * Without the fix named here every call fails, so the message has to carry it.
 */
export class AccountError extends ReporterError {
  constructor(command: string, code: number, accountId?: string) {
    super(
      code,
      code === 214
        ? "This access token has access to more than one Apple account, so Reporter will not pick one. Set APPLE_PODCASTS_ACCOUNT_ID to the account number you want to read and restart the MCP client. Reporter's viewToken command lists the accounts a token can reach."
        : `Account number ${accountId ? `"${accountId}"` : "specified"} is not one this access token can read. Check APPLE_PODCASTS_ACCOUNT_ID, or unset it if the token only has one account.`,
      command,
    );
    this.name = "AccountError";
  }
}

/** Code 117, or HTTP 429/503 — Apple is throttling or reports are delayed. */
export class RateLimitError extends ReporterError {
  constructor(command: string, code = 117) {
    super(
      code,
      "Apple is throttling requests or the reports are delayed. Each date in a range is a separate Reporter call, so wide ranges hit this first. Narrow the date range or wait and retry.",
      command,
    );
    this.name = "RateLimitError";
  }
}

/** Codes 201-208 — bad report type, date type, or a combination Apple rejects. */
export class BadRequestError extends ReporterError {
  constructor(command: string, code: number, detail: string) {
    super(
      code,
      `${detail} Check the report type, period, and date format (YYYYMMDD for daily and weekly, YYYYMM for monthly).`,
      command,
    );
    this.name = "BadRequestError";
  }
}

const CODE_MESSAGES: Record<number, string> = {
  100: "Application and method name are incorrectly specified.",
  101: "Invalid method specified.",
  102: "Too few or too many parameters specified for the method.",
  110: "Network is not available.",
  111: "Network is available but cannot connect to the Reporter service.",
  114: "API version is not specified.",
  115: "API version of the service endpoint does not match.",
  119: "Report was not fully downloaded.",
  120: "The version parameter is invalid.",
  121: "The version parameter is required.",
  201: "Invalid report type specified.",
  202: "Invalid report subtype specified.",
  203: "Invalid combination of report type and report subtype.",
  204: "Invalid date type specified.",
  205: "Invalid date.",
  206: "Invalid combination of report subtype and date type.",
  207: "Invalid date.",
  208: "Invalid combination of date type and date.",
  212: "An unexpected error occurred on Apple's side.",
  214: "This token has access to more than one account; specify an account number.",
  215: "Invalid account number specified.",
};

/**
 * Map a Reporter error code (and optional HTTP status) to a typed error.
 *
 * `code` is Apple's in-body numeric code when we could parse one. When Apple
 * returns a bare HTTP failure with no parseable body, pass `undefined` and the
 * status so transport-level failures still land on a sensible class.
 */
export function mapReporterError(args: {
  code: number | undefined;
  message: string;
  command: string;
  httpStatus?: number;
  vendorId?: string;
  accountId?: string;
  date?: string;
}): ReporterError {
  const { code, message, command, httpStatus, vendorId, accountId, date } = args;

  if (code === 123) return new TokenExpiredError(command);
  if (code === 124 || code === 125 || code === 132) {
    return new TokenInvalidError(command, code);
  }
  if (code === 200 || code === 300) {
    return new VendorError(command, vendorId ?? "unknown", code);
  }
  if (code === 209 || code === 211 || code === 213) {
    return new NoDataError(command, date ?? "the requested date", code);
  }
  if (code === 214 || code === 215) {
    return new AccountError(command, code, accountId);
  }
  if (code === 117) return new RateLimitError(command, code);
  if (code !== undefined && code >= 201 && code <= 208) {
    return new BadRequestError(command, code, CODE_MESSAGES[code] ?? message);
  }
  if (code !== undefined) {
    return new ReporterError(code, CODE_MESSAGES[code] ?? message, command);
  }

  // No parseable Reporter code — fall back to HTTP status.
  if (httpStatus === 401 || httpStatus === 403) {
    return new TokenInvalidError(command);
  }
  if (httpStatus === 429 || httpStatus === 503) {
    return new RateLimitError(command);
  }
  return new ReporterError(httpStatus ?? 0, message, command);
}

/**
 * Strip anything token-shaped out of text that came back over the wire.
 *
 * Apple does not echo the access token, so this is not a fix for a known leak.
 * It is cheap insurance against the middlebox case: a corporate proxy, a WAF
 * block page, or a captive portal that mirrors the request it rejected would
 * put the whole `jsonRequest` form field — access token included — into a body
 * this parser then quotes into a user-visible error and an agent transcript.
 * The alternative, dropping the body entirely, would cost the one thing that
 * makes those failures diagnosable, so redact rather than discard.
 */
export function redactSecrets(text: string): string {
  // The quote characters are optional and may themselves be backslash-escaped:
  // a mirrored body can arrive as raw form text, as JSON, or as JSON nested
  // inside a JSON string, and the token has to come out of all three.
  const quote = String.raw`(?:\\?["'])?`;
  return text
    .replace(/(jsonRequest=)\S+/gi, "$1[redacted]")
    .replace(
      new RegExp(
        `(${quote}accesstoken${quote}\\s*[:=]\\s*${quote})[^"'\\\\&,}\\s]+`,
        "gi",
      ),
      "$1[redacted]",
    );
}

/**
 * Pull a Reporter error code and message out of a response body.
 *
 * Reporter answers in one of three shapes depending on mode and failure kind:
 *   - Robot.XML:  <Error><Code>213</Code><Message>...</Message></Error>
 *   - JSON:       {"code": 213, "message": "..."}  (some deployments)
 *   - Plain text: "Error 213 - There were no sales for the date specified"
 *
 * The body is redacted before parsing, because the text form quotes it back to
 * the user and the body is not always Apple's. Returns `code: undefined` when
 * nothing parses, so the caller can fall back to the HTTP status.
 */
export function parseReporterError(body: string): {
  code: number | undefined;
  message: string;
} {
  const trimmed = redactSecrets(body.trim());
  if (!trimmed) return { code: undefined, message: "Empty response from Reporter." };

  const xmlCode = /<Code>\s*(\d+)\s*<\/Code>/i.exec(trimmed);
  const xmlMessage = /<Message>([\s\S]*?)<\/Message>/i.exec(trimmed);
  if (xmlCode) {
    return {
      code: Number(xmlCode[1]),
      message: (xmlMessage?.[1] ?? "").trim() || "Reporter returned an error.",
    };
  }

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as {
        code?: unknown;
        Code?: unknown;
        message?: unknown;
        Message?: unknown;
      };
      const raw = parsed.code ?? parsed.Code;
      const code = typeof raw === "number" ? raw : Number(raw);
      const message =
        (typeof parsed.message === "string" && parsed.message) ||
        (typeof parsed.Message === "string" && parsed.Message) ||
        "Reporter returned an error.";
      if (Number.isFinite(code)) return { code, message };
      return { code: undefined, message };
    } catch {
      // Not JSON after all — fall through to the plain-text form.
    }
  }

  const textCode = /\b(?:error|code)\D{0,3}(\d{3})\b/i.exec(trimmed);
  return {
    code: textCode ? Number(textCode[1]) : undefined,
    message: trimmed.slice(0, 500),
  };
}
