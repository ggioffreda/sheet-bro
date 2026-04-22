/// <reference types="vite/client" />

interface LaunchParams {
  readonly files: ReadonlyArray<FileSystemFileHandle>
}
interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => void | Promise<void>): void
}
interface Window {
  readonly launchQueue?: LaunchQueue
}
