import { describe, expect, it } from "vitest";
import {
  AccountError,
  BadRequestError,
  mapReporterError,
  NoDataError,
  parseReporterError,
  RateLimitError,
  ReporterError,
  TokenExpiredError,
  TokenInvalidError,
  VendorError,
} from "../errors.js";
import {
  ERROR_BAD_DATE,
  ERROR_BAD_VENDOR,
  ERROR_DELAYED,
  ERROR_NO_DATA,
  ERROR_TOKEN_EXPIRED,
  ERROR_TOKEN_INVALID,
} from "./fixtures/reports.js";

describe("parseReporterError", () => {
  it("reads code and message out of Apple's XML envelope", () => {
    expect(parseReporterError(ERROR_TOKEN_EXPIRED)).toEqual({
      code: 123,
      message: "Your Access Token is expired",
    });
    expect(parseReporterError(ERROR_NO_DATA).code).toBe(213);
  });

  it("reads a JSON error body", () => {
    expect(parseReporterError('{"code":200,"message":"Invalid vendor"}')).toEqual({
      code: 200,
      message: "Invalid vendor",
    });
  });

  it("reads a code out of a plain-text body", () => {
    const parsed = parseReporterError(
      "Error 213 - There were no sales for the date specified",
    );
    expect(parsed.code).toBe(213);
  });

  it("returns no code when nothing parses", () => {
    expect(parseReporterError("service unavailable").code).toBeUndefined();
    expect(parseReporterError("").code).toBeUndefined();
  });

  it("redacts a token out of a body that mirrors the request back", () => {
    // Apple does not echo the token, but a proxy or WAF block page can mirror
    // the request it rejected. The plain-text branch quotes the body into a
    // message the user and the agent transcript both see.
    const mirrored =
      'Request blocked by policy. Error 403 - body was jsonRequest=%7B%22accesstoken%22%3A%22s3cr3t-token%22%7D';
    const { message } = parseReporterError(mirrored);
    expect(message).not.toMatch(/s3cr3t-token/);
    expect(message).toMatch(/\[redacted\]/);
    // The diagnosable part of the body survives.
    expect(message).toMatch(/Request blocked by policy/);

    const jsonEcho = parseReporterError(
      '{"code":401,"message":"rejected: {\\"accesstoken\\":\\"s3cr3t-token\\",\\"version\\":\\"2.2\\"}"}',
    );
    expect(jsonEcho.message).not.toMatch(/s3cr3t-token/);
  });
});

describe("mapReporterError", () => {
  const map = (body: string, extra: Record<string, unknown> = {}) => {
    const { code, message } = parseReporterError(body);
    return mapReporterError({
      code,
      message,
      command: "Sales.getReport",
      ...extra,
    });
  };

  it("maps 123 to an expired-token error that names the 180-day rotation", () => {
    const err = map(ERROR_TOKEN_EXPIRED);
    expect(err).toBeInstanceOf(TokenExpiredError);
    expect(err.message).toMatch(/180 days/);
    expect(err.message).toMatch(/APPLE_PODCASTS_ACCESS_TOKEN/);
  });

  it("maps 124 to an invalid-token error, distinct from expiry", () => {
    const err = map(ERROR_TOKEN_INVALID);
    expect(err).toBeInstanceOf(TokenInvalidError);
    expect(err).not.toBeInstanceOf(TokenExpiredError);
  });

  it("maps 200 to a vendor error that quotes the vendor number tried", () => {
    const err = map(ERROR_BAD_VENDOR, { vendorId: "12345678" });
    expect(err).toBeInstanceOf(VendorError);
    expect(err.message).toMatch(/"12345678"/);
    expect(err.message).toMatch(/apple_podcasts_check_access/);
  });

  it("maps 213 to a no-data error naming the date", () => {
    const err = map(ERROR_NO_DATA, { date: "20260728" });
    expect(err).toBeInstanceOf(NoDataError);
    expect(err.message).toMatch(/20260728/);
  });

  it("maps 117 to a rate-limit error", () => {
    expect(map(ERROR_DELAYED)).toBeInstanceOf(RateLimitError);
  });

  it("maps date/type codes to a bad-request error explaining the format", () => {
    const err = map(ERROR_BAD_DATE);
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err.message).toMatch(/YYYYMMDD/);
  });

  it("maps 214 to an account error naming the variable that fixes it", () => {
    // Code 214 is unrecoverable without an account number, so the message has
    // to say where to put one rather than restating Apple's sentence.
    const err = mapReporterError({
      code: 214,
      message: "This token has access to more than one account",
      command: "Sales.getReport",
    });
    expect(err).toBeInstanceOf(AccountError);
    expect(err.message).toMatch(/APPLE_PODCASTS_ACCOUNT_ID/);
  });

  it("maps 215 to an account error quoting the number that was rejected", () => {
    const err = mapReporterError({
      code: 215,
      message: "Invalid account number specified",
      command: "Sales.getReport",
      accountId: "2011425",
    });
    expect(err).toBeInstanceOf(AccountError);
    expect(err.message).toMatch(/"2011425"/);
  });

  it("falls back to HTTP status when the body carries no code", () => {
    expect(
      mapReporterError({
        code: undefined,
        message: "forbidden",
        command: "Sales.getReport",
        httpStatus: 403,
      }),
    ).toBeInstanceOf(TokenInvalidError);

    expect(
      mapReporterError({
        code: undefined,
        message: "slow down",
        command: "Sales.getReport",
        httpStatus: 429,
      }),
    ).toBeInstanceOf(RateLimitError);

    const generic = mapReporterError({
      code: undefined,
      message: "teapot",
      command: "Sales.getReport",
      httpStatus: 418,
    });
    expect(generic).toBeInstanceOf(ReporterError);
    expect(generic.code).toBe(418);
  });

  it("keeps every mapped error distinguishable by class", () => {
    // Guards against a refactor that collapses the hierarchy into one class.
    const classes = [
      map(ERROR_TOKEN_EXPIRED).name,
      map(ERROR_TOKEN_INVALID).name,
      map(ERROR_BAD_VENDOR).name,
      map(ERROR_NO_DATA).name,
      map(ERROR_DELAYED).name,
      map(ERROR_BAD_DATE).name,
    ];
    expect(new Set(classes).size).toBe(6);
  });
});
