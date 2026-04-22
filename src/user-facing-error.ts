// Tag applied to error messages that are safe to show verbatim to the user.
// Thrown at boundaries that already surface user-actionable text (file
// limits, timeouts, known-shape validation failures). Everything else
// caught in app.ts falls back to a generic "See browser console for
// details." message so internal error strings don't leak.
export class UserFacingError extends Error {
  readonly userFacing = true
  constructor(message: string) {
    super(message)
    this.name = 'UserFacingError'
  }
}

export function toUserMessage(err: unknown, fallback: string): string {
  if (err instanceof UserFacingError) return `${fallback} ${err.message}`
  return `${fallback} See browser console for details.`
}
