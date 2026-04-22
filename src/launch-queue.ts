import { MAX_FILE_BYTES, notify, runImport } from './app'

export function registerLaunchQueueConsumer() {
  if (!('launchQueue' in window)) return
  window.launchQueue!.setConsumer(async (params: LaunchParams) => {
    for (const handle of params.files) {
      let file: File
      try {
        file = await handle.getFile()
      } catch (err) {
        console.error('launchQueue: could not read file handle', err)
        continue
      }
      if (file.size > MAX_FILE_BYTES) {
        notify(
          `File too large (${(file.size / 1e6).toFixed(1)} MB; limit is ${MAX_FILE_BYTES / 1e6} MB).`,
          true,
        )
        continue
      }
      await runImport(file)
    }
  })
}
