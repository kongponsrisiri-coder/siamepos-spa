import React, { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';

// Touch + mouse signature pad. Exposes getDataURL() / clear() / isEmpty() via ref.
// Stores result as a PNG base64 string for client_medical.digital_signature.

const SignaturePad = forwardRef(function SignaturePad({ initialDataUrl, height = 160 }, ref) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const dirtyRef = useRef(false);
  const lastRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    // High-DPI: render at device-pixel size, scale back via CSS.
    const ratio = window.devicePixelRatio || 1;
    const cssWidth = canvas.parentElement.clientWidth;
    canvas.width = cssWidth * ratio;
    canvas.height = height * ratio;
    canvas.style.width = cssWidth + 'px';
    canvas.style.height = height + 'px';
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#111';

    if (initialDataUrl) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, cssWidth, height);
      img.src = initialDataUrl;
    }
  }, []); // eslint-disable-line

  function pointerPos(e) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  }

  function start(e) {
    e.preventDefault();
    drawingRef.current = true;
    lastRef.current = pointerPos(e);
  }
  function move(e) {
    if (!drawingRef.current) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext('2d');
    const p = pointerPos(e);
    ctx.beginPath();
    ctx.moveTo(lastRef.current.x, lastRef.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastRef.current = p;
    dirtyRef.current = true;
  }
  function end() { drawingRef.current = false; }

  useImperativeHandle(ref, () => ({
    clear: () => {
      const c = canvasRef.current;
      c.getContext('2d').clearRect(0, 0, c.width, c.height);
      dirtyRef.current = false;
    },
    isEmpty: () => !dirtyRef.current,
    getDataURL: () => (dirtyRef.current ? canvasRef.current.toDataURL('image/png') : null),
  }));

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, background: 'white' }}>
      <canvas
        ref={canvasRef}
        onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
        onTouchStart={start} onTouchMove={move} onTouchEnd={end}
        style={{ display: 'block', touchAction: 'none', cursor: 'crosshair' }}
      />
    </div>
  );
});

export default SignaturePad;
