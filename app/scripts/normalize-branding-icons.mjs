import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = new Uint32Array(256);

for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  return upDistance <= upperLeftDistance ? up : upperLeft;
}

export function decodePng(file) {
  if (!file.subarray(0, 8).equals(signature)) throw new Error("expected a PNG file");
  const chunks = [];
  for (let offset = 8; offset < file.length; ) {
    const length = file.readUInt32BE(offset);
    const type = file.toString("ascii", offset + 4, offset + 8);
    chunks.push({ type, data: file.subarray(offset + 8, offset + 8 + length) });
    offset += length + 12;
  }
  const header = chunks.find(({ type }) => type === "IHDR")?.data;
  if (!header || header[8] !== 8 || ![2, 6].includes(header[9]) || header[12] !== 0) {
    throw new Error("expected a non-interlaced 8-bit RGB or RGBA PNG");
  }

  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const colorType = header[9];
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const compressed = Buffer.concat(chunks.filter(({ type }) => type === "IDAT").map(({ data }) => data));
  const filtered = inflateSync(compressed);
  if (filtered.length !== height * (stride + 1)) throw new Error("unexpected PNG data length");
  const pixels = Buffer.alloc(width * height * channels);

  for (let row = 0; row < height; row += 1) {
    const filter = filtered[row * (stride + 1)];
    const sourceOffset = row * (stride + 1) + 1;
    const targetOffset = row * stride;
    for (let column = 0; column < stride; column += 1) {
      const raw = filtered[sourceOffset + column];
      const left = column >= channels ? pixels[targetOffset + column - channels] : 0;
      const up = row > 0 ? pixels[targetOffset + column - stride] : 0;
      const upperLeft = row > 0 && column >= channels ? pixels[targetOffset + column - stride - channels] : 0;
      let predictor;
      if (filter === 0) predictor = 0;
      else if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, upperLeft);
      else throw new Error(`unsupported PNG filter ${filter}`);
      pixels[targetOffset + column] = (raw + predictor) & 0xff;
    }
  }
  return { width, height, colorType, pixels };
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.length + 8);
  return result;
}

export function encodePng({ width, height, colorType, pixels }) {
  if (![2, 6].includes(colorType)) throw new Error("expected RGB or RGBA pixels");
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  if (pixels.length !== stride * height) throw new Error("pixel buffer length does not match dimensions");

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    pixels.copy(scanlines, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function resizeRgba(source, width, height) {
  if (source.colorType !== 6) throw new Error("expected RGBA source pixels");
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = (y + 0.5) * source.height / height - 0.5;
    const y0 = Math.max(0, Math.floor(sourceY));
    const y1 = Math.min(source.height - 1, y0 + 1);
    const vertical = Math.max(0, sourceY - y0);
    for (let x = 0; x < width; x += 1) {
      const sourceX = (x + 0.5) * source.width / width - 0.5;
      const x0 = Math.max(0, Math.floor(sourceX));
      const x1 = Math.min(source.width - 1, x0 + 1);
      const horizontal = Math.max(0, sourceX - x0);
      const samples = [
        [x0, y0, (1 - horizontal) * (1 - vertical)],
        [x1, y0, horizontal * (1 - vertical)],
        [x0, y1, (1 - horizontal) * vertical],
        [x1, y1, horizontal * vertical],
      ];
      let alpha = 0;
      const premultiplied = [0, 0, 0];
      for (const [sampleX, sampleY, weight] of samples) {
        const offset = (sampleY * source.width + sampleX) * 4;
        const sampleAlpha = source.pixels[offset + 3];
        alpha += sampleAlpha * weight;
        for (let channel = 0; channel < 3; channel += 1) {
          premultiplied[channel] += source.pixels[offset + channel] * sampleAlpha * weight;
        }
      }
      const target = (y * width + x) * 4;
      pixels[target + 3] = Math.round(alpha);
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[target + channel] = alpha === 0 ? 0 : Math.round(premultiplied[channel] / alpha);
      }
    }
  }
  return { width, height, colorType: 6, pixels };
}

export function flattenToRgb(source, background = [255, 255, 255]) {
  if (source.colorType === 2) return source;
  const pixels = Buffer.alloc(source.width * source.height * 3);
  for (let sourceOffset = 0, targetOffset = 0; sourceOffset < source.pixels.length; sourceOffset += 4, targetOffset += 3) {
    const alpha = source.pixels[sourceOffset + 3];
    for (let channel = 0; channel < 3; channel += 1) {
      pixels[targetOffset + channel] = Math.round(
        (source.pixels[sourceOffset + channel] * alpha + background[channel] * (255 - alpha)) / 255,
      );
    }
  }
  return { width: source.width, height: source.height, colorType: 2, pixels };
}

function normalize(iconRoot) {
  const canonical = decodePng(readFileSync(join(iconRoot, "icon.png")));
  for (const [density, size] of Object.entries({
    mdpi: 48,
    hdpi: 72,
    xhdpi: 96,
    xxhdpi: 144,
    xxxhdpi: 192,
  })) {
    writeFileSync(
      join(iconRoot, "android", `mipmap-${density}`, "ic_launcher.png"),
      encodePng(resizeRgba(canonical, size, size)),
    );
  }
  const roundSource = decodePng(readFileSync(join(iconRoot, "android", "mipmap-xhdpi", "ic_launcher_round.png")));
  writeFileSync(
    join(iconRoot, "android", "mipmap-hdpi", "ic_launcher_round.png"),
    encodePng(resizeRgba(roundSource, 72, 72)),
  );
  const iosRoot = join(iconRoot, "ios");
  for (const name of readdirSync(iosRoot).filter((entry) => entry.endsWith(".png")).sort()) {
    const path = join(iosRoot, name);
    writeFileSync(path, encodePng(flattenToRgb(decodePng(readFileSync(path)))));
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === import.meta.filename) {
  const [iconRoot] = process.argv.slice(2);
  if (!iconRoot || process.argv.length !== 3) {
    console.error("usage: node normalize-branding-icons.mjs <icons-directory>");
    process.exitCode = 1;
  } else {
    normalize(resolve(iconRoot));
  }
}
