// SPA-VOUCHER-QR-001 — scan a voucher's QR code with the device camera.
//
// The voucher QR (Apple / Google Wallet pass, emailed voucher) carries just
// the voucher code, so whatever we decode is handed straight back to the
// caller as the code. Uses the native BarcodeDetector where the browser has
// one (Chrome on Android / macOS) and falls back to jsQR everywhere else
// (Windows till, Safari, Firefox).
//
// A USB / Bluetooth handheld scanner needs none of this — it types the code
// into the voucher box and presses Enter like a keyboard.
import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';

export default function QrScanModal({ onResult, onClose, title = 'Scan voucher QR' }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(true);

  useEffect(() => {
    let stream = null;
    let raf = 0;
    let stopped = false;
    let detector = null;

    function stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach(t => t.stop());
    }

    function done(text) {
      const code = String(text || '').trim();
      if (!code || stopped) return;
      stop();
      if (navigator.vibrate) { try { navigator.vibrate(80); } catch {} }
      onResult(code);
    }

    async function tick() {
      if (stopped) return;
      const video = videoRef.current;
      if (video && video.readyState >= 2 && video.videoWidth) {
        try {
          if (detector) {
            const found = await detector.detect(video);
            if (found && found[0]) return done(found[0].rawValue);
          } else {
            const canvas = canvasRef.current;
            // Scan a scaled-down frame — plenty for a phone-screen QR and
            // keeps an older till's CPU calm.
            const scale = Math.min(1, 640 / video.videoWidth);
            const w = Math.round(video.videoWidth * scale);
            const h = Math.round(video.videoHeight * scale);
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(video, 0, 0, w, h);
            const img = ctx.getImageData(0, 0, w, h);
            const hit = jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' });
            if (hit && hit.data) return done(hit.data);
          }
        } catch { /* one bad frame — try the next */ }
      }
      raf = requestAnimationFrame(tick);
    }

    (async () => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setStarting(false);
        setError('This device or browser has no camera access. Type the voucher code instead.');
        return;
      }
      try {
        if ('BarcodeDetector' in window) {
          const formats = await window.BarcodeDetector.getSupportedFormats();
          if (formats.includes('qr_code')) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        }
      } catch { detector = null; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (stopped) { stream.getTracks().forEach(t => t.stop()); return; }
        const video = videoRef.current;
        video.srcObject = stream;
        await video.play();
        setStarting(false);
        raf = requestAnimationFrame(tick);
      } catch (e) {
        setStarting(false);
        const name = e && e.name;
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          setError('Camera permission was refused. Allow the camera for this app, then try again — or type the voucher code.');
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          setError('No camera found on this device. Type the voucher code instead.');
        } else if (name === 'NotReadableError') {
          setError('The camera is busy in another app. Close it and try again.');
        } else {
          setError('Could not start the camera. Type the voucher code instead.');
        }
      }
    })();

    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(13,27,62,0.75)', zIndex: 9800, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: 'white', borderRadius: 14, width: 'min(94vw, 420px)', padding: 16, boxShadow: '0 20px 60px rgba(0,0,0,0.35)' }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>📷 {title}</h3>
          <button onClick={onClose} style={{ minHeight: 36 }}>✕</button>
        </div>
        {error ? (
          <div style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8, padding: '12px 14px', fontSize: 14, lineHeight: 1.45 }}>
            {error}
          </div>
        ) : (
          <div style={{ position: 'relative', background: '#000', borderRadius: 10, overflow: 'hidden', aspectRatio: '4 / 3' }}>
            <video ref={videoRef} playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            {/* aiming square */}
            <div style={{
              position: 'absolute', left: '50%', top: '50%', width: '58%', aspectRatio: '1 / 1',
              transform: 'translate(-50%, -50%)', border: '3px solid rgba(255,255,255,0.9)', borderRadius: 12,
              boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)', pointerEvents: 'none',
            }} />
            {starting && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: 14 }}>
                Starting camera…
              </div>
            )}
          </div>
        )}
        <canvas ref={canvasRef} style={{ display: 'none' }} />
        {!error && (
          <div className="muted" style={{ fontSize: 13, marginTop: 10, textAlign: 'center' }}>
            Hold the voucher's QR code inside the square.
          </div>
        )}
      </div>
    </div>
  );
}
