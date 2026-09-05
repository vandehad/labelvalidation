/**
 * Reading a barcode with a phone camera.
 *
 * A third way to get characters into the same two scan fields - after the
 * keyboard wedge and the MC92N0's form posts. Nothing downstream knows the
 * difference: the text goes through `normalizeScan` like any other scan, so
 * the six-character zone field is stripped and the reversed-scan gate still
 * applies.
 *
 * Two decoders, chosen at runtime:
 *
 *   BarcodeDetector   built into Chrome and Edge on Android. Native, fast, no
 *                     download. Used when it is there and can read Code 39.
 *   ZXing             a JavaScript decoder, loaded only when needed. Safari
 *                     still does not ship BarcodeDetector, so this is the only
 *                     route on an iPhone - and it is a dynamic import so the
 *                     TC52s and laptops, which never open a camera, never
 *                     download it.
 *
 * A camera reads the same label thirty times a second. `debounceCode` makes a
 * decode count once, then ignores repeats of it for a while - otherwise the
 * second scan of a pair would be the first label again.
 */

export type StopCamera = () => void

type Detection = { rawValue: string }
type DetectorCtor = new (opts?: { formats?: string[] }) => { detect(src: HTMLVideoElement): Promise<Detection[]> }
type DetectorStatic = DetectorCtor & { getSupportedFormats?: () => Promise<string[]> }

const FORMATS = ['code_39', 'code_128']

/** Same code again within `windowMs` is the camera still looking at it, not a new scan. */
export function debounceCode(windowMs = 1500, now: () => number = Date.now) {
  let lastCode = ''
  let lastAt = 0
  return (code: string): boolean => {
    const t = now()
    if (code === lastCode && t - lastAt < windowMs) {
      lastAt = t // still looking at it - keep the window open
      return false
    }
    lastCode = code
    lastAt = t
    return true
  }
}

async function nativeDetector(): Promise<DetectorCtor | null> {
  const D = (globalThis as { BarcodeDetector?: DetectorStatic }).BarcodeDetector
  if (!D) return null
  try {
    const supported = (await D.getSupportedFormats?.()) ?? []
    // It has to read Code 39 - that is what the racks carry.
    if (supported.length && !supported.includes('code_39')) return null
  } catch {
    return null
  }
  return D
}

/**
 * Open the rear camera into `video` and call `onCode` for each barcode read.
 * Resolves once the stream is live; rejects if the camera cannot be opened
 * (no permission, no camera, or not HTTPS - getUserMedia refuses otherwise).
 */
export async function startCamera(
  video: HTMLVideoElement,
  onCode: (code: string) => void,
  opts: { debounceMs?: number } = {},
): Promise<StopCamera> {
  const fresh = debounceCode(opts.debounceMs ?? 1500)
  const emit = (raw: string) => {
    const code = String(raw ?? '').trim()
    if (code && fresh(code)) onCode(code)
  }

  const Native = await nativeDetector()
  if (Native) {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    })
    video.srcObject = stream
    video.setAttribute('playsinline', 'true') // iOS would otherwise go full screen
    video.muted = true
    await video.play()

    const detector = new Native({ formats: FORMATS })
    let alive = true
    let busy = false
    const tick = async () => {
      if (!alive) return
      if (!busy && video.readyState >= 2) {
        busy = true
        try {
          const found = await detector.detect(video)
          for (const f of found) emit(f.rawValue)
        } catch {
          /* a frame it could not read - try the next one */
        }
        busy = false
      }
      // ~8 looks a second is plenty for a label held still, and leaves the
      // phone's CPU alone between them.
      if (alive) setTimeout(tick, 120)
    }
    void tick()

    return () => {
      alive = false
      for (const t of stream.getTracks()) t.stop()
      video.srcObject = null
    }
  }

  // Fallback: ZXing, fetched on first use.
  const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
    import('@zxing/browser'),
    import('@zxing/library'),
  ])
  const hints = new Map()
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_39, BarcodeFormat.CODE_128])
  hints.set(DecodeHintType.TRY_HARDER, true)
  const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 120 })
  video.setAttribute('playsinline', 'true')
  const controls = await reader.decodeFromConstraints(
    { video: { facingMode: { ideal: 'environment' } }, audio: false },
    video,
    result => {
      if (result) emit(result.getText())
    },
  )
  return () => controls.stop()
}

/** True where a camera can be asked for at all. */
export function cameraAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
}
