# SH-08 runtime status design

## Oracle and scope

The reviewed package defines a fixed 24px bottom bar on `#0d0d10`, using 11px muted text. Its
left identity is provider, selected model, and thinking level. Its right evidence is context use,
a 56px meter, first-token latency, tokens per second, and an amber exact overload code.

Production data must replace the package's simulated counters. This change uses only admitted
root-session snapshots, exact session composer projections, and cursor-guarded inspector details.
Missing evidence is displayed as unavailable, never as zero.

## Authority composition

`RootSessionProjection` remains the authority for runtime state, freshness, current-chat usage,
and cursor-bound CV-04 performance. The selected model and thinking projection is admitted only
when the composer response is bound to the exact displayed session, runtime generation, and
sequence.

Context occupancy and overload notices remain owned by the existing Harness inspector load. The
inspector emits a small immutable status projection after its existing identity/epoch guards have
accepted the result. This reuses its sole background poll and monotonic clock; the status bar does
not load, poll, or run a timer. A stale completion cannot render because the status projection and
the renderer both compare session, generation, and sequence.

An overload is displayed only when the verified inspector projects the exact
`server_is_overloaded` detail. An empty admitted notice set proves no overload. Unavailable
inspector details mean overload truth is unavailable.

## Responsive and accessible behavior

The bar is exactly 24 CSS pixels tall. Wide layouts preserve the package ordering. At 640px the
labels become compact while retaining every value. At 320px/2x, lower-priority model and thinking
visual labels collapse from the one-line bar; the bar's accessible name and per-item titles retain
the complete verified/unavailable status without horizontal document or bar overflow.

The bar stays keyboard focusable for status inspection, uses a named status landmark, exposes
unavailable reasons through an accessible description, and does not announce fabricated progress.

## Testing

Unit tests cover exact bindings, stale/cross-session rejection, unavailable/hostile inputs,
overload truth, zero-versus-unavailable semantics, and composer binding. Strict Playwright tests
measure the exact height, content geometry, responsive 640x400 and 320x200@2x behavior, keyboard
focus, full accessible status, and axe results.
