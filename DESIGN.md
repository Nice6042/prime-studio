---
name: Prime Studio
description: A quiet three-pane desktop chat workspace with an operational Harness inspector.
colors:
  app-bg: "#0b0b0d"
  center-bg: "#0e0e11"
  sidebar-bg: "#111114"
  inspector-bg: "#101013"
  card: "#141419"
  raised: "#17171c"
  hover: "#1d1d22"
  active: "#26262d"
  text-primary: "#e9e9ee"
  text-body: "#dcdce2"
  text-secondary: "#9a9aa6"
  text-muted: "#8a8a94"
  text-faint: "#6d6d78"
  accent: "#8e85f0"
  accent-link: "#a9a2ff"
  accent-selection: "#dedbff"
  success: "#3ecf8e"
  success-light: "#7ee2b8"
  info: "#6aa2f7"
  warning: "#e2b34e"
  danger: "#e5484d"
  danger-light: "#ff8f93"
  child-purple: "#a78bfa"
typography:
  title:
    fontFamily: "Segoe UI, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "Segoe UI, system-ui, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Segoe UI, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 500
    lineHeight: 1.35
  mono:
    fontFamily: "Consolas, ui-monospace, monospace"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.65
rounded:
  control-sm: "5px"
  control: "7px"
  button: "9px"
  card: "11px"
  bubble: "14px"
  composer: "16px"
  pill: "99px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.app-bg}"
    rounded: "{rounded.button}"
    padding: "8px 12px"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.card}"
    padding: "12px"
  composer:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.composer}"
    padding: "12px"
---

# Design System: Prime Studio

## Overview

**Creative North Star: "The Quiet Operator's Console"**

Prime Studio looks familiar enough that a desktop-chat user can start immediately, while the
Harness inspector reveals operational depth without contaminating the parent conversation. The
visual system is dark, neutral, precise, and intentionally low-chrome. Identity comes from the
violet diamond, exact pane rhythm, restrained status color, and dense but legible operational
detail—not decorative dashboards.

This is a target contract extracted from the owner-approved package. The existing partial UI is
an implementation checkpoint, not competing visual authority.

**Key Characteristics:**

- A stable sidebar / parent conversation / Harness inspector topology.
- Near-black tonal layering, quiet one-pixel boundaries, and one restrained violet accent.
- Familiar desktop controls with explicit hover, focus, active, disabled, loading, and error states.
- Parent chat stays spacious; operational and accounting regions may be denser.

## Colors

Near-black neutral layers separate regions without visible panel chrome. Violet marks selection,
focus, and primary action only; semantic colors always have text or icon equivalents.

**The One Accent Rule.** Prime violet is reserved for focus, selection, links, and the current
primary action. It is not decoration.

**The Truthful State Rule.** Success, warning, and danger colors report verified state only and
never imply progress, cost, availability, or completion that the runtime did not provide.

## Typography

**Display Font:** Segoe UI with system UI fallbacks
**Body Font:** Segoe UI with system UI fallbacks
**Label/Mono Font:** Consolas with system monospace fallbacks

The hierarchy is compact and workmanlike: 13.5px body copy, 12–12.5px controls, 11–11.5px
metadata, and 15–17px section titles. Settings page titles may reach 24px. Parent assistant prose
uses a 1.6 line height and a readable maximum measure; paths, diffs, commands, and exact counts use
mono.

**The Conversation Measure Rule.** Parent prose stays within 780px. Operational tables and diffs
may run wider only inside their dedicated pane.

## Layout

The desktop shell has a 40px title bar, one flexible workspace row, and a 24px status bar. The
sidebar prefers 264px and is user-resizable from 210–380px. The Harness inspector prefers 384px
and is user-resizable from 300–600px. The center never falls below 340px plus separator slack.

An editor sits between conversation and inspector at 280–600px, capped at 46% of the available
workspace. When the width budget cannot preserve the center, the inspector becomes a focus-managed
sheet or hides with a persistent reopen action; below the sidebar budget, navigation becomes a
52px rail. Settings replaces the workspace and uses grouped navigation plus a scrolling content
column. At narrow widths and 200% zoom, no primary action may be lost or require horizontal page
scroll.

**The Center Wins Rule.** Resizing clamps side regions before it violates the parent conversation's
minimum. Persisted preferences never override the current viewport budget.

## Elevation & Depth

The shell is flat by default. Region depth comes from close neutral values and low-alpha 1px
boundaries. Only transient overlays and menus receive the established `0 14px 40px` dark shadow;
cards inside fixed panes do not float.

**The Overlay-Only Shadow Rule.** A shadow indicates stacking or temporary focus, never ordinary
content importance.

## Shapes

Small controls use 5–7px corners; buttons and compact rows use 8–9px; large cards use 11px; user
bubbles use 14px; the composer uses 16px; pills and toggles are fully rounded. Dividers are quiet
and borders stay thin. The violet nested diamond is the product's recurring geometric mark.

## Components

### Buttons

- Primary controls use violet with dark ink and reserve the treatment for the immediate action.
- Secondary and ghost controls sit on transparent or raised neutral surfaces.
- Every interactive control has visible hover, focus-visible, active, disabled, loading, and error
  behavior; an unsupported control includes a concise reason.

### Chips

Attachment, filter, shortcut, model, and state chips share compact type and rounded geometry.
Selected chips may use violet or the active neutral; unselected chips remain quiet.

### Cards / Containers

Cards use the card or raised token, an 8–11px corner, a quiet border, and 10–12px internal rhythm.
Avoid wrapping every list row in a separate card.

### Inputs / Fields

Inputs inherit the raised neutral surface and compact radius. Focus is a violet border shift with
an unambiguous focus-visible outline. Error and disabled states remain legible without relying on
opacity alone.

### Navigation

The active chat uses a violet-tinted selection with `text-selection`; inactive rows are flat and
gain the hover neutral. Expanded/collapsed navigation exposes the same actions, order, labels, and
keyboard paths.

### Harness Inspector

Harness, Usage, and Activity are fixed top tabs. Child detail replaces the inspector contents and
keeps private Chat, Activity, and Files tabs inside the panel. Current-chat usage stays here;
account-wide usage never does.

### Composer

The composer is a 16px raised card with a bounded auto-growing textarea. Attachments and slash
matches live above the input; model, thinking, microphone state, send/stop, estimate, and send hint
live below and wrap together when needed.

## Do's and Don'ts

### Do:

- **Do** keep the parent conversation free of child transcripts, tool telemetry, and reasoning
  detail.
- **Do** preserve exact pane minima, the resize budget, keyboard completeness, and focus recovery.
- **Do** label unavailable, stale, degraded, disconnected, rejected, and unknown outcomes directly.
- **Do** show account-wide usage only inside Settings → Usage.

### Don't:

- **Don't** copy the reference HTML, renderer, inline SVG paths, demo copy, fake names, fake counts,
  or simulated timings into production.
- **Don't** ship a clickable no-op or substitute a toast for a required operation.
- **Don't** invent approvals for ordinary child-agent execution.
- **Don't** use gradients, glass, glowing edges, decorative charts, excessive cards, or branded
  assets from ChatGPT, Codex, T3Code, or the prototype.
