# CP-01 bounded composer growth design

## Evidence and scope

The reviewed package specifies a one-row textarea with `field-sizing: content`, a 140 CSS-pixel
maximum height, 13.5px text at 1.5 line-height, and 2px by 4px input padding inside the existing
16px-radius composer card. Prime Studio currently renders the correct controlled textarea and
composer topology, but lacks intrinsic field sizing and uses an unexercised 180px maximum.

CP-01 changes only the textarea's intrinsic layout. It does not alter prompt admission, Enter and
Shift+Enter behavior, IME handling, attachment layout, slash commands, draft persistence, or
per-chat draft ownership.

## Design

Use Chromium's native `field-sizing: content` behavior rather than measuring `scrollHeight` in
React. Native intrinsic sizing responds to text wrapping, viewport changes, zoom, font metrics,
and controlled draft replacement without an observer or layout effect. Keep `rows={1}` as the
minimum-size semantic and cap the textarea at the package-authoritative 140 CSS pixels. Before the
cap, vertical overflow is hidden; after the cap, the textarea scrolls internally. Horizontal
overflow remains hidden and text wraps normally.

The behavior is expressed by a dedicated composer-input class and a single exported maximum-height
constant used as a CSS custom property. This keeps the package bound testable without duplicating
the number in component logic and CSS.

## Responsive and accessibility behavior

The same CSS-pixel bound applies at wide, compact, and 200% zoom layouts. The textarea shrinks when
content is removed or when a different chat's shorter controlled draft is rendered. Focus stays on
the native textarea, scrollbar access remains native, and no live announcement is added because
height is visual layout state rather than a user-facing status change.

## Verification

- Component tests prove the exact bound, one-row start, multiline/IME callbacks, and controlled
  draft replacement without cross-chat mutation.
- Browser tests measure growth, the 140px cap, internal overflow, shrink-back, Shift+Enter, IME-safe
  Enter, document overflow, and axe results at wide and compact widths.
- The narrow browser project repeats the height/overflow/axe checks at a 320 CSS-pixel viewport
  with device scale factor 2, matching the repository's 200% reflow harness.
