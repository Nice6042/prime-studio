import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { inflateSync } from "node:zlib";

import { expect, test } from "vitest";

import { decodePng, encodePng, resizeRgba } from "./normalize-branding-icons.mjs";

const appRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(appRoot, "..");
const iconRoot = join(appRoot, "src-tauri", "icons");

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

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

function parsePng(path) {
  const file = readFileSync(path);
  expect(file.subarray(0, 8), relative(appRoot, path)).toEqual(pngSignature);
  const chunks = [];
  for (let offset = 8; offset < file.length; ) {
    const length = file.readUInt32BE(offset);
    const type = file.toString("ascii", offset + 4, offset + 8);
    const data = file.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = file.readUInt32BE(offset + 8 + length);
    expect(crc32(file.subarray(offset + 4, offset + 8 + length)), `${relative(appRoot, path)} ${type} CRC`).toBe(expectedCrc);
    chunks.push({ type, data });
    offset += 12 + length;
  }

  const header = chunks[0].data;
  return {
    path,
    chunks,
    width: header.readUInt32BE(0),
    height: header.readUInt32BE(4),
    bitDepth: header[8],
    colorType: header[9],
    compression: header[10],
    filter: header[11],
    interlace: header[12],
  };
}

function alphaExtrema(png) {
  if (png.colorType === 2) return [255, 255];
  expect(png.colorType, relative(appRoot, png.path)).toBe(6);
  const bytesPerPixel = 4;
  const stride = png.width * bytesPerPixel;
  const compressed = Buffer.concat(png.chunks.filter(({ type }) => type === "IDAT").map(({ data }) => data));
  const filtered = inflateSync(compressed);
  const pixels = Buffer.alloc(stride * png.height);
  let minimum = 255;
  let maximum = 0;

  for (let row = 0; row < png.height; row += 1) {
    const filter = filtered[row * (stride + 1)];
    const sourceOffset = row * (stride + 1) + 1;
    const targetOffset = row * stride;
    for (let column = 0; column < stride; column += 1) {
      const raw = filtered[sourceOffset + column];
      const left = column >= bytesPerPixel ? pixels[targetOffset + column - bytesPerPixel] : 0;
      const up = row > 0 ? pixels[targetOffset + column - stride] : 0;
      const upperLeft = row > 0 && column >= bytesPerPixel ? pixels[targetOffset + column - stride - bytesPerPixel] : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + Math.floor((left + up) / 2);
      else if (filter === 4) {
        const estimate = left + up - upperLeft;
        const leftDistance = Math.abs(estimate - left);
        const upDistance = Math.abs(estimate - up);
        const upperLeftDistance = Math.abs(estimate - upperLeft);
        const predictor = leftDistance <= upDistance && leftDistance <= upperLeftDistance
          ? left
          : upDistance <= upperLeftDistance ? up : upperLeft;
        value = raw + predictor;
      } else throw new Error(`unsupported PNG filter ${filter}`);
      pixels[targetOffset + column] = value & 0xff;
    }
    for (let column = 3; column < stride; column += bytesPerPixel) {
      const alpha = pixels[targetOffset + column];
      minimum = Math.min(minimum, alpha);
      maximum = Math.max(maximum, alpha);
    }
  }
  return [minimum, maximum];
}

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function hashesBelow(directory) {
  return Object.fromEntries(filesBelow(directory).sort().map((path) => [
    relative(directory, path).replaceAll("\\", "/"),
    createHash("sha256").update(readFileSync(path)).digest("hex"),
  ]));
}

test("canonical and browser SVG copies are identical code-native artwork", () => {
  const canonical = readFileSync(join(repositoryRoot, "assets", "branding", "prime-studio-mark.svg"));
  const browser = readFileSync(join(appRoot, "public", "prime-studio-mark.svg"));
  expect(browser).toEqual(canonical);
  const source = canonical.toString("utf8");
  expect(source).not.toMatch(/<(?:image|text|use)\b/i);
  expect(source).not.toMatch(/(?:href|src)\s*=/i);
});

test("desktop and Store PNGs have the expected dimensions and alpha", () => {
  const expected = {
    "32x32.png": 32,
    "64x64.png": 64,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
    "StoreLogo.png": 50,
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
  };
  for (const [name, size] of Object.entries(expected)) {
    const png = parsePng(join(iconRoot, name));
    expect([png.width, png.height], name).toEqual([size, size]);
    expect(alphaExtrema(png)[0], name).toBe(0);
  }
});

test("Android launcher assets match every platform density", () => {
  const densities = {
    mdpi: { launcher: 48, foreground: 108 },
    hdpi: { launcher: 72, foreground: 162 },
    xhdpi: { launcher: 96, foreground: 216 },
    xxhdpi: { launcher: 144, foreground: 324 },
    xxxhdpi: { launcher: 192, foreground: 432 },
  };
  for (const [density, sizes] of Object.entries(densities)) {
    for (const [name, size] of [
      ["ic_launcher.png", sizes.launcher],
      ["ic_launcher_round.png", sizes.launcher],
      ["ic_launcher_foreground.png", sizes.foreground],
    ]) {
      const png = parsePng(join(iconRoot, "android", `mipmap-${density}`, name));
      expect([png.width, png.height], `${density}/${name}`).toEqual([size, size]);
    }
  }
});

test("Android launcher rasterization is derived from the canonical generated icon", () => {
  const canonical = decodePng(readFileSync(join(iconRoot, "icon.png")));
  for (const [density, size] of Object.entries({
    mdpi: 48,
    hdpi: 72,
    xhdpi: 96,
    xxhdpi: 144,
    xxxhdpi: 192,
  })) {
    expect(
      readFileSync(join(iconRoot, "android", `mipmap-${density}`, "ic_launcher.png")),
      density,
    ).toEqual(encodePng(resizeRgba(canonical, size, size)));
  }
});

test("iOS icons match required point scales and are fully opaque RGB", () => {
  const expected = {
    "AppIcon-20x20@1x.png": 20,
    "AppIcon-20x20@2x-1.png": 40,
    "AppIcon-20x20@2x.png": 40,
    "AppIcon-20x20@3x.png": 60,
    "AppIcon-29x29@1x.png": 29,
    "AppIcon-29x29@2x-1.png": 58,
    "AppIcon-29x29@2x.png": 58,
    "AppIcon-29x29@3x.png": 87,
    "AppIcon-40x40@1x.png": 40,
    "AppIcon-40x40@2x-1.png": 80,
    "AppIcon-40x40@2x.png": 80,
    "AppIcon-40x40@3x.png": 120,
    "AppIcon-60x60@2x.png": 120,
    "AppIcon-60x60@3x.png": 180,
    "AppIcon-76x76@1x.png": 76,
    "AppIcon-76x76@2x.png": 152,
    "AppIcon-83.5x83.5@2x.png": 167,
    "AppIcon-512@2x.png": 1024,
  };
  for (const [name, size] of Object.entries(expected)) {
    const png = parsePng(join(iconRoot, "ios", name));
    expect([png.width, png.height], name).toEqual([size, size]);
    expect(png.colorType, `${name} PNG color type`).toBe(2);
    expect(alphaExtrema(png), name).toEqual([255, 255]);
  }
});

test("generated PNGs carry only deterministic structural metadata", () => {
  const pngs = filesBelow(iconRoot).filter((path) => path.endsWith(".png"));
  expect(pngs).toHaveLength(48);
  for (const path of pngs) {
    const png = parsePng(path);
    expect(png.chunks.map(({ type }) => type), relative(iconRoot, path)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(png.width, relative(iconRoot, path)).toBe(png.height);
    expect(png.bitDepth, relative(iconRoot, path)).toBe(8);
    expect([2, 6], relative(iconRoot, path)).toContain(png.colorType);
    expect([png.compression, png.filter, png.interlace], relative(iconRoot, path)).toEqual([0, 0, 0]);
  }
});

test("ICO and ICNS containers include the required frame families", () => {
  const ico = readFileSync(join(iconRoot, "icon.ico"));
  expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);
  const icoSizes = [];
  for (let index = 0; index < ico.readUInt16LE(4); index += 1) {
    const offset = 6 + index * 16;
    icoSizes.push(ico[offset] || 256);
    expect(ico[offset + 1] || 256).toBe(ico[offset] || 256);
  }
  expect(icoSizes.sort((left, right) => left - right)).toEqual([16, 24, 32, 48, 64, 256]);

  const icns = readFileSync(join(iconRoot, "icon.icns"));
  expect(icns.toString("ascii", 0, 4)).toBe("icns");
  expect(icns.readUInt32BE(4)).toBe(icns.length);
  const tags = [];
  for (let offset = 8; offset < icns.length; ) {
    const length = icns.readUInt32BE(offset + 4);
    expect(length).toBeGreaterThanOrEqual(8);
    expect(offset + length).toBeLessThanOrEqual(icns.length);
    tags.push(icns.toString("ascii", offset, offset + 4));
    offset += length;
  }
  expect(tags).toEqual([...tags].sort());
  expect(tags).toEqual(["ic07", "ic08", "ic09", "ic10", "ic11", "ic12", "ic13", "ic14", "il32", "is32", "l8mk", "s8mk"]);
});

test("branding regeneration is byte-for-byte deterministic", () => {
  const before = hashesBelow(iconRoot);
  const windows = process.platform === "win32";
  const result = spawnSync(windows ? process.env.ComSpec : "npm", windows
    ? ["/d", "/s", "/c", "npm run branding:icons"]
    : ["run", "branding:icons"], {
    cwd: appRoot,
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(hashesBelow(iconRoot)).toEqual(before);
}, 150_000);
