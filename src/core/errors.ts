export type ErrorCode =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "forbidden"
  | "insufficient_credits"
  | "rate_limited"
  | "blocked_by_rule"
  | "provider_unavailable";

export class AdError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retry_after?: number,
  ) {
    super(message);
  }
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
};
