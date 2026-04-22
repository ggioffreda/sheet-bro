import { initApp } from './app'
import { registerLaunchQueueConsumer } from './launch-queue'
import { registerServiceWorker } from './sw-register'

initApp().then(registerLaunchQueueConsumer)

if (import.meta.env.PROD && !import.meta.env.VITE_E2E) {
  registerServiceWorker()
}
