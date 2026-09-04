// Convert raw pixel data to BMP.
// Based on canvas-to-bmp ((c) 2015 Ken "Epistemex" Fyrstenberg, MIT).
function rgba2bmp(ab, w, h) {
  function setU16(v) {view.setUint16(pos, v, true); pos += 2;}
  function setU32(v) {view.setUint32(pos, v, true); pos += 4;}

  const headerSize = 54;                             // 14 + 40 bytes
  const stride = w * 4;                              // row length incl. padding
  const pixelArraySize = stride * h;                 // total bitmap size
  const fileLength = headerSize + pixelArraySize;    // header size is known + bitmap
  const file = new ArrayBuffer(fileLength);          // raw byte buffer (returned)
  const view = new DataView(file);                   // handle endian, reg. width etc.
  const data32 = new Uint32Array(ab);                // 32-bit representation of canvas
  let pos = 0;

  // BMP header.
  setU16(0x4d42);         // BM
  setU32(fileLength);     // total length
  pos += 4;               // skip unused fields
  setU32(headerSize);     // offset to pixels

  // DIB header.
  setU32(40);             // DIB header size
  setU32(w);              // width
  setU32(-h >>> 0);       // negative = top-to-bottom
  setU16(1);              // 1 plane
  setU16(32);             // 32-bit (ARGB)
  setU32(0);              // no compression (BI_RGB)
  setU32(pixelArraySize); // bitmap size incl. padding (stride x height)

  pos = headerSize;
  // Bitmap data, change order from ABGR to ARGB.
  data32.forEach(abgr => {
      const b = (abgr >> 16) & 0xff;
      const r = abgr & 0xff;
      setU32(abgr & 0xff00ff00 | (r << 16) | b);
  });

  return file;
}
