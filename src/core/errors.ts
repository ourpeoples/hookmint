export type ErrorCode =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "forbidden"
  | "insufficient_credits"
  | "rate_limited"
  | "blocked_by_rule"
  | "provider_unavailable"
  | "payload_too_large"
  | "unsupported_media_type";

export class AdError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retry_after?: number,
    options: { retry?: boolean } = {},
  ) {
    super(message);
    this.retry = options.retry ?? true;
  }

  /**
   * Whether trying the same call again soon could succeed. A provider's rate limit passes quickly, so it is
   * retryable. One of OUR limits (a daily allowance) will not change for hours, so it is final: pass retry: false.
   */
  readonly retry: boolean;
}

export const HTTP_STATUS: Record<ErrorCode, number> = {
  invalid_input: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  insufficient_credits: 402,
  rate_limited: 429,
  blocked_by_rule: 422,
  provider_unavailable: 503,
  payload_too_large: 413,
  unsupported_media_type: 415,
};
