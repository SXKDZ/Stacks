# PA stylesheet architecture

PA uses Tailwind for layout, Lucide for icons, shared React controls for behavior,
and these responsibility-based CSS modules for the application skin. `globals.css`
is only the ordered import manifest.

- `foundation.css` — the only dark-default token source, reset, shell, and navigation
- `themes.css` — light-theme token overrides and theme-specific surfaces
- `design-system.css` — shared buttons, badges, fields, states, motion, and focus treatment
- `data-interactions.css` — tables, filters, sorting, resizing, and pagination
- `library-details.css` — library entities and the paper detail workspace
- `management-workflows.css` — add/edit/import/export/storage modals and workflows
- `reading-assistant.css` — reader and assistant content surfaces
- `settings.css` — settings navigation and forms
- `workspaces.css` — standalone chat and reader layouts

## Rules

1. Colors are semantic tokens. New raw color literals belong only in
   `foundation.css` or the light-theme token block in `themes.css`.
2. Buttons, links, status pills, and icon controls use the primitives in
   `app/components/ui/controls.tsx`; feature modules must not redefine them.
3. A new stylesheet requires a genuinely new responsibility. It must not be an
   override patch for an existing component.
4. Hover, focus, active, disabled, light, and dark states are defined together.
5. Keep import order stable and verify desktop and narrow viewports after changes.

The generated `public/color-audit.html` is the visual inventory for every raw
color that remains while the legacy feature rules are being migrated to tokens.
