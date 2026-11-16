import qrcode from "qrcode-generator";

/**
 * Black on white with a quiet zone, whatever the theme: scanners need the contrast. The text only goes into the QR
 * encoder; the SVG is built from numbers, so nothing from `text` is ever interpreted as markup.
 */
export function QrCode({ text, label }: { text: string; label: string }) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  const quiet = 4;
  let path = "";
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (qr.isDark(row, col)) path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
    }
  }
  const total = size + quiet * 2;
  return (
    <svg
      className="qr"
      viewBox={`0 0 ${total} ${total}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={total} height={total} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
