# Prime Studio brand assets

`prime-studio-mark.svg` is the canonical source for the application icon and browser favicon.
The abstract woven-aperture geometry and its color palette were authored directly in SVG for
this repository. It contains no copied logo, third-party font, remote asset, rendered text, or
human likeness.

The generated desktop, Windows Store, iOS, and Android icon files in `app/src-tauri/icons/` are
derived from this SVG with the repository-pinned Tauri CLI. The script then normalizes upstream
output without external image libraries: it sorts nondeterministically ordered ICNS chunks,
rebuilds every ordinary Android launcher density from the generated canonical `icon.png`, repairs
the malformed 49 px Android `hdpi` round launcher at the required 72 px density, and flattens iOS
icons onto white as fully opaque RGB PNGs:

```powershell
cd app
npm run branding:icons
```

The browser copy at `app/public/prime-studio-mark.svg` must remain byte-for-byte identical to
the canonical source. The artwork is maintained as a project-owned asset under the repository's
license. This provenance record describes the artwork's origin; it is not a trademark search or
clearance opinion for the product name.
