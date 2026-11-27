import { parentPort, workerData } from 'node:worker_threads'

parentPort.on('message', ({ id, job }) => {
  switch (job.bytes[0]) {
    case 1: // Simulate a decoder that never returns.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
      return
    case 2:
      throw new Error('fixture worker crashed')
    case 3:
      parentPort.postMessage({ id, out: [{ analyzer: 'green-threshold', version: 2, results: [{ slot: 16, metric: 'green_fraction', value: 0.5 }] }] })
      return
    default:
      parentPort.postMessage({ id, out: workerData.learned.map(({ id: analyzer }) => ({ analyzer, version: 1, results: [] })) })
  }
})
