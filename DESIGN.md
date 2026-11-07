---
version: alpha
colors:
  primary: '#173a8a'
  editor: '#050505'
  sidebar: '#171717'
  raised: '#282828'
  text: '#e8e8e8'
  muted: '#a0a0a0'
  accentText: '#bddbff'
  paper: '#ffffff'
typography:
  ui:
    fontFamily: Arial, Helvetica, sans-serif
  source:
    fontFamily: DejaVu Sans Mono, Liberation Mono, monospace
  paper:
    fontFamily: Liberation Serif, Times New Roman, serif
rounded:
  control: 12px
  panel: 20px
omitted:
  - section: spacing
    reason: Existing runtime spacing tokens remain canonical.
  - section: components
    reason: Shared Solid components remain canonical.
---

# Loom design

## Overview

Loom is a local scientific writing workspace. Source, conversation, and PDF share one workspace. The paper preview retains its white page while surrounding controls follow the chosen theme. Keep feedback quiet, readable, and actionable.

## Colors

`src/renderer/ui/tokens.css` owns runtime tokens. `src/renderer/appearance/appearance.css` owns theme overrides. The values above describe the default theme; this document does not generate CSS. Reuse semantic variables for new controls.

## Typography

UI controls use the system sans-serif stack. Source uses monospace. Paper content uses its document fonts. Small status text must remain readable beside primary actions.

## Layout

The project sidebar, editor, conversation, and PDF each retain their existing scroll ownership. Menus and dialogs must fit the viewport without changing panel widths. At narrow widths, use existing workspace navigation rather than adding competing panels.

## Elevation & Depth

Use existing floating-menu and dialog shadows. Errors remain near the relevant operation. PDF failures retain the last successful PDF.

## Shapes

Controls and panels use the existing radius tokens. Avoid adding badges or containers for ordinary text feedback.

## Components

`src/renderer/ui/primitives.tsx` owns buttons and modal behavior. `ActionMenu.tsx` owns keyboard menus. `BuildFeedback.tsx` owns PDF recovery actions. Agent activity uses a subtle dot pulse only during confirmed work. Reduced motion disables the pulse.

## Do's and Don'ts

Name the failed operation and its recovery action. Preserve drafts and author writing. Keep technical details accessible without forcing the user to interpret them before continuing. Do not animate waiting, disconnected, or uncertain agent states as active work.
