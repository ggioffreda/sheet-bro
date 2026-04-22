import { describe, expect, it } from 'vitest'
import { toUserMessage, UserFacingError } from './user-facing-error'

describe('UserFacingError', () => {
  it('is an Error with the userFacing tag and name set', () => {
    const err = new UserFacingError('boom')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(UserFacingError)
    expect(err.userFacing).toBe(true)
    expect(err.name).toBe('UserFacingError')
    expect(err.message).toBe('boom')
  })
})

describe('toUserMessage', () => {
  it('appends a UserFacingError message to the fallback', () => {
    const err = new UserFacingError('File too big.')
    expect(toUserMessage(err, 'Could not read file.')).toBe('Could not read file. File too big.')
  })

  it('hides unknown error details behind a generic suffix', () => {
    expect(toUserMessage(new Error('SELECT * FROM users'), 'Could not read file.')).toBe(
      'Could not read file. See browser console for details.',
    )
    expect(toUserMessage('string error', 'Could not read file.')).toBe(
      'Could not read file. See browser console for details.',
    )
    expect(toUserMessage(null, 'Could not read file.')).toBe(
      'Could not read file. See browser console for details.',
    )
  })
})
