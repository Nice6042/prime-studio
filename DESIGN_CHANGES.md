# Prime Studio interface principles

Prime Studio is a Windows-first workbench for a separately installed Prime runtime. Its interface
is independently authored around the repository's woven-aperture identity and the runtime behavior
documented in this project.

## Conversation first

The transcript is the primary reading surface. Assistant prose carries the strongest hierarchy;
tool cells, child activity, status, context, and spend remain available without competing with the
answer. Tool failures open automatically, decisions remain easy to scan, and the plain-language
status line explains active work above the composer.

Quiet sessions stay quiet. Empty metrics, child, kernel, or plan regions do not reserve space.
Before the first turn, workspace selection and the composer form one compact starting surface.

## Workspace structure

- The sidebar groups sessions by working folder because a session's filesystem scope is bound to
  that folder.
- The reading column owns the transcript and composer.
- The right rail contains live session measurements and interpreter health when those facts exist.
- The artifact pane owns file discovery and previews, with independent scrolling.
- Settings uses stable navigation and one focused pane per section.

At narrow effective viewports the sidebar becomes a compact scrollable strip, secondary session
details collapse, and artifacts use an independently scrollable overlay. The transcript and
composer always retain nonzero usable space.

## Visual system

The canonical aperture mark supplies the product's three ribbon accents: violet, coral, and sage.
Charcoal-plum work surfaces keep code and long-form text calm. Fine interlaced seams at major
boundaries echo the mark's construction; decoration elsewhere is deliberately restrained.

All interactive controls have visible keyboard focus, sufficient contrast, and usable hit targets.
The interface honors reduced-motion and forced-color preferences. No network font or remote visual
asset is required.

## Capability truth

Only capabilities exposed by the current product contracts appear as operable controls. Missing
runtime features are described plainly. Prime applies executable cells as the model emits them, so
the first-run warning and file-review language must remain direct about that effect boundary.
