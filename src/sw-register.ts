import { notify } from './app'

const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000
const SCRIPT_URL_KEY = 'sheet-bro.sw.scriptURL'
const BASE = import.meta.env.BASE_URL
const EXPECTED_PATH = `${BASE}sw.js`

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return

  window.addEventListener('load', () => {
    void bootstrap()
  })
}

async function bootstrap() {
  try {
    const registration = await navigator.serviceWorker.register(EXPECTED_PATH, { scope: BASE })

    verifyScriptURL(registration)

    if (registration.waiting && navigator.serviceWorker.controller) {
      promptForUpdate(registration)
    }

    registration.addEventListener('updatefound', () => {
      const installing = registration.installing
      if (!installing) return
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          promptForUpdate(registration)
        }
      })
    })

    let reloading = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return
      reloading = true
      window.location.reload()
    })

    setInterval(() => {
      if (document.visibilityState === 'visible') {
        registration.update().catch(() => {})
      }
    }, UPDATE_INTERVAL_MS)
  } catch {
    // Registration failures on plain HTTP or unsupported browsers are
    // silent by design — persistence surfaces its own fallback.
  }
}

function verifyScriptURL(registration: ServiceWorkerRegistration) {
  const active = registration.active
  if (!active) return
  let pathname: string
  try {
    pathname = new URL(active.scriptURL).pathname
  } catch {
    return
  }
  const previous = sessionStorage.getItem(SCRIPT_URL_KEY)
  if (pathname !== EXPECTED_PATH) {
    notify('Security warning: unexpected service worker path detected. Clear site data and reload.', true)
    return
  }
  if (previous !== null && previous !== pathname) {
    notify('Security warning: service worker path changed between sessions. Clear site data and reload.', true)
  }
  try {
    sessionStorage.setItem(SCRIPT_URL_KEY, pathname)
  } catch {
    // sessionStorage may be unavailable (private mode quota) — degrade silently.
  }
}

function promptForUpdate(registration: ServiceWorkerRegistration) {
  notify('A new version is available. Reload to apply.', true)
  const handler = () => {
    if (!registration.waiting) return
    registration.waiting.postMessage({ type: 'SKIP_WAITING' })
  }
  // Reload on user-initiated full reload is the natural path; we also
  // respond to a click anywhere on the sticky toast.
  const notifyEl = document.getElementById('notify')
  if (notifyEl) {
    notifyEl.addEventListener('click', handler, { once: true })
  }
}
