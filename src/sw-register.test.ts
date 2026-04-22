import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./app', () => ({ notify: vi.fn() }))

import { notify } from './app'
import { registerServiceWorker } from './sw-register'

const notifyMock = vi.mocked(notify)

class FakeSW extends EventTarget {
  scriptURL = 'http://localhost/sw.js'
  state: ServiceWorkerState = 'installing'
  postMessage = vi.fn()
}

class FakeRegistration extends EventTarget {
  active: FakeSW | null = null
  waiting: FakeSW | null = null
  installing: FakeSW | null = null
  update = vi.fn().mockResolvedValue(undefined)
}

type MockContainer = EventTarget & {
  register: ReturnType<typeof vi.fn>
  controller: FakeSW | null
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const setController = (container: MockContainer, value: FakeSW | null) => {
  Object.defineProperty(container, 'controller', { value, configurable: true, writable: true })
}

describe('sw-register', () => {
  let container: MockContainer
  let originalDescriptor: PropertyDescriptor | undefined
  let loadHandler: (() => void) | null
  let addEventListenerSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    notifyMock.mockClear()
    sessionStorage.clear()
    document.body.innerHTML = ''

    loadHandler = null
    addEventListenerSpy = vi.spyOn(window, 'addEventListener').mockImplementation(
      ((event: string, handler: EventListenerOrEventListenerObject) => {
        if (event === 'load' && typeof handler === 'function') {
          loadHandler = handler as () => void
        }
      }) as typeof window.addEventListener,
    )

    const base = new EventTarget() as MockContainer
    base.register = vi.fn()
    setController(base, null)
    container = base

    originalDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'serviceWorker')
    Object.defineProperty(navigator, 'serviceWorker', {
      value: container,
      configurable: true,
      writable: true,
    })

    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    })
  })

  afterEach(() => {
    addEventListenerSpy.mockRestore()
    vi.useRealTimers()
    if (originalDescriptor) {
      Object.defineProperty(Navigator.prototype, 'serviceWorker', originalDescriptor)
    }
    // Remove instance-level override to let the prototype show through again.
    try {
      delete (navigator as { serviceWorker?: unknown }).serviceWorker
    } catch {
      Object.defineProperty(navigator, 'serviceWorker', {
        value: undefined,
        configurable: true,
      })
    }
  })

  const triggerLoad = async () => {
    loadHandler?.()
    await flush()
  }

  it('does nothing if serviceWorker is absent from navigator', async () => {
    // Remove the instance-level override AND hide the prototype getter so
    // `'serviceWorker' in navigator` evaluates to false.
    delete (navigator as { serviceWorker?: unknown }).serviceWorker
    const protoDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'serviceWorker')
    if (protoDescriptor) delete (Navigator.prototype as { serviceWorker?: unknown }).serviceWorker
    expect('serviceWorker' in navigator).toBe(false)

    registerServiceWorker()
    expect(addEventListenerSpy).not.toHaveBeenCalled()

    if (protoDescriptor) Object.defineProperty(Navigator.prototype, 'serviceWorker', protoDescriptor)
  })

  it('registers the worker at /sw.js with root scope on load', async () => {
    container.register.mockResolvedValue(new FakeRegistration())
    registerServiceWorker()
    await triggerLoad()
    expect(container.register).toHaveBeenCalledWith('/sw.js', { scope: '/' })
  })

  it('silently swallows registration errors (plain HTTP / unsupported)', async () => {
    container.register.mockRejectedValue(new Error('ssl required'))
    registerServiceWorker()
    await triggerLoad()
    expect(notifyMock).not.toHaveBeenCalled()
  })

  describe('prompt-for-update on bootstrap', () => {
    it('notifies when a waiting worker already exists and a controller is live', async () => {
      const reg = new FakeRegistration()
      reg.waiting = new FakeSW()
      setController(container, new FakeSW())
      container.register.mockResolvedValue(reg)

      registerServiceWorker()
      await triggerLoad()

      expect(notifyMock).toHaveBeenCalledWith(
        'A new version is available. Reload to apply.',
        true,
      )
    })

    it('does not notify when waiting exists but no controller is live', async () => {
      const reg = new FakeRegistration()
      reg.waiting = new FakeSW()
      setController(container, null)
      container.register.mockResolvedValue(reg)

      registerServiceWorker()
      await triggerLoad()

      expect(notifyMock).not.toHaveBeenCalled()
    })

    it('posts SKIP_WAITING when the toast is clicked and waiting is still set', async () => {
      const reg = new FakeRegistration()
      const waiting = new FakeSW()
      reg.waiting = waiting
      setController(container, new FakeSW())
      container.register.mockResolvedValue(reg)

      const toast = document.createElement('div')
      toast.id = 'notify'
      document.body.appendChild(toast)

      registerServiceWorker()
      await triggerLoad()

      toast.click()

      expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    })

    it('skips postMessage when waiting has cleared before the click', async () => {
      const reg = new FakeRegistration()
      const waiting = new FakeSW()
      reg.waiting = waiting
      setController(container, new FakeSW())
      container.register.mockResolvedValue(reg)

      const toast = document.createElement('div')
      toast.id = 'notify'
      document.body.appendChild(toast)

      registerServiceWorker()
      await triggerLoad()

      reg.waiting = null
      toast.click()

      expect(waiting.postMessage).not.toHaveBeenCalled()
    })

    it('does not throw when the #notify element is missing', async () => {
      const reg = new FakeRegistration()
      reg.waiting = new FakeSW()
      setController(container, new FakeSW())
      container.register.mockResolvedValue(reg)

      // document.body is cleared in beforeEach, so #notify definitely doesn't exist.
      registerServiceWorker()
      await triggerLoad()

      expect(notifyMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('updatefound lifecycle', () => {
    it('notifies when installing transitions to installed with a live controller', async () => {
      const reg = new FakeRegistration()
      setController(container, new FakeSW())
      container.register.mockResolvedValue(reg)

      registerServiceWorker()
      await triggerLoad()

      const installing = new FakeSW()
      reg.installing = installing
      reg.dispatchEvent(new Event('updatefound'))

      installing.state = 'installed'
      installing.dispatchEvent(new Event('statechange'))

      expect(notifyMock).toHaveBeenCalledWith(
        'A new version is available. Reload to apply.',
        true,
      )
    })

    it('does not notify when statechange reaches installed but no controller exists (first install)', async () => {
      const reg = new FakeRegistration()
      setController(container, null)
      container.register.mockResolvedValue(reg)

      registerServiceWorker()
      await triggerLoad()

      const installing = new FakeSW()
      reg.installing = installing
      reg.dispatchEvent(new Event('updatefound'))

      installing.state = 'installed'
      installing.dispatchEvent(new Event('statechange'))

      expect(notifyMock).not.toHaveBeenCalled()
    })

    it('does not notify when state transitions to a non-installed value', async () => {
      const reg = new FakeRegistration()
      setController(container, new FakeSW())
      container.register.mockResolvedValue(reg)

      registerServiceWorker()
      await triggerLoad()

      const installing = new FakeSW()
      reg.installing = installing
      reg.dispatchEvent(new Event('updatefound'))

      installing.state = 'activating'
      installing.dispatchEvent(new Event('statechange'))

      expect(notifyMock).not.toHaveBeenCalled()
    })

    it('bails out of updatefound when registration.installing is null', async () => {
      const reg = new FakeRegistration()
      container.register.mockResolvedValue(reg)

      registerServiceWorker()
      await triggerLoad()

      reg.installing = null
      reg.dispatchEvent(new Event('updatefound'))

      expect(notifyMock).not.toHaveBeenCalled()
    })
  })

  describe('controllerchange reload', () => {
    it('reloads the window on controllerchange exactly once', async () => {
      const reg = new FakeRegistration()
      container.register.mockResolvedValue(reg)

      const reload = vi.fn()
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...window.location, reload },
      })

      registerServiceWorker()
      await triggerLoad()

      container.dispatchEvent(new Event('controllerchange'))
      container.dispatchEvent(new Event('controllerchange'))

      expect(reload).toHaveBeenCalledTimes(1)
    })
  })

  describe('periodic update check', () => {
    it('calls registration.update when the tab is visible', async () => {
      const reg = new FakeRegistration()
      container.register.mockResolvedValue(reg)

      registerServiceWorker()
      await triggerLoad()

      vi.advanceTimersByTime(6 * 60 * 60 * 1000)

      expect(reg.update).toHaveBeenCalledTimes(1)
    })

    it('skips registration.update when the tab is hidden', async () => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      })

      const reg = new FakeRegistration()
      container.register.mockResolvedValue(reg)

      registerServiceWorker()
      await triggerLoad()

      vi.advanceTimersByTime(6 * 60 * 60 * 1000)

      expect(reg.update).not.toHaveBeenCalled()
    })

    it('swallows update() rejections silently', async () => {
      const reg = new FakeRegistration()
      reg.update = vi.fn().mockRejectedValue(new Error('offline'))
      container.register.mockResolvedValue(reg)

      registerServiceWorker()
      await triggerLoad()

      vi.advanceTimersByTime(6 * 60 * 60 * 1000)
      await flush()

      expect(reg.update).toHaveBeenCalled()
      expect(notifyMock).not.toHaveBeenCalled()
    })
  })

  describe('verifyScriptURL', () => {
    it('does nothing when the registration has no active worker', async () => {
      const reg = new FakeRegistration()
      reg.active = null
      container.register.mockResolvedValue(reg)

      registerServiceWorker()
      await triggerLoad()

      expect(notifyMock).not.toHaveBeenCalled()
      expect(sessionStorage.getItem('sheet-bro.sw.scriptURL')).toBeNull()
    })

    it('returns silently when scriptURL is not a parseable URL', async () => {
      const reg = new FakeRegistration()
      const active = new FakeSW()
      active.scriptURL = 'not-a-valid-url'
      reg.active = active
      container.register.mockResolvedValue(reg)

      registerServiceWorker()
      await triggerLoad()

      expect(notifyMock).not.toHaveBeenCalled()
      expect(sessionStorage.getItem('sheet-bro.sw.scriptURL')).toBeNull()
    })

    it('warns when the active scriptURL has an unexpected pathname', async () => {
      const reg = new FakeRegistration()
      const active = new FakeSW()
      active.scriptURL = 'http://localhost/attacker-sw.js'
      reg.active = active
      container.register.mockResolvedValue(reg)

      registerServiceWorker()
      await triggerLoad()

      expect(notifyMock).toHaveBeenCalledWith(
        'Security warning: unexpected service worker path detected. Clear site data and reload.',
        true,
      )
      // Warning path returns before the sessionStorage write.
      expect(sessionStorage.getItem('sheet-bro.sw.scriptURL')).toBeNull()
    })

    it('stores the pathname on a fresh session (no warning)', async () => {
      const reg = new FakeRegistration()
      const active = new FakeSW()
      active.scriptURL = 'http://localhost/sw.js'
      reg.active = active
      container.register.mockResolvedValue(reg)

      registerServiceWorker()
      await triggerLoad()

      expect(notifyMock).not.toHaveBeenCalled()
      expect(sessionStorage.getItem('sheet-bro.sw.scriptURL')).toBe('/sw.js')
    })

    it('stays silent when the stored pathname matches the current one', async () => {
      sessionStorage.setItem('sheet-bro.sw.scriptURL', '/sw.js')

      const reg = new FakeRegistration()
      const active = new FakeSW()
      active.scriptURL = 'http://localhost/sw.js'
      reg.active = active
      container.register.mockResolvedValue(reg)

      registerServiceWorker()
      await triggerLoad()

      expect(notifyMock).not.toHaveBeenCalled()
    })

    it('warns when the stored pathname differs from the current one across sessions', async () => {
      sessionStorage.setItem('sheet-bro.sw.scriptURL', '/old-sw.js')

      const reg = new FakeRegistration()
      const active = new FakeSW()
      active.scriptURL = 'http://localhost/sw.js'
      reg.active = active
      container.register.mockResolvedValue(reg)

      registerServiceWorker()
      await triggerLoad()

      expect(notifyMock).toHaveBeenCalledWith(
        'Security warning: service worker path changed between sessions. Clear site data and reload.',
        true,
      )
    })

    it('degrades silently when sessionStorage.setItem throws (e.g. private-mode quota)', async () => {
      const reg = new FakeRegistration()
      const active = new FakeSW()
      active.scriptURL = 'http://localhost/sw.js'
      reg.active = active
      container.register.mockResolvedValue(reg)

      const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError')
      })

      registerServiceWorker()
      await triggerLoad()

      expect(notifyMock).not.toHaveBeenCalled()
      spy.mockRestore()
    })
  })
})
