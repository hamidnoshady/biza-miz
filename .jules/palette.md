## 2024-10-24 - Invalid focus rings on Tailwind elements
**Learning:** Tailwind CSS does not provide a `ring-3` utility out of the box (the scale is `ring-1`, `ring-2`, `ring`, `ring-4`). This caused elements relying on `focus-visible:ring-3` to fail silently when receiving keyboard focus, resulting in an inaccessible experience.
**Action:** Always use `focus-visible:ring-2` (or the default `focus-visible:ring`) when styling elements for keyboard accessibility.

## 2024-10-25 - Missing focus-visible states on inline links and text buttons
**Learning:** Interactive text elements like inline links (`<Link>`), breadcrumbs, and small action buttons (e.g., "keep current value") often rely only on `hover:underline` for visual feedback. This leaves keyboard users without any visible focus indicator, making navigation difficult and inaccessible.
**Action:** Always ensure that inline links and text buttons include standard focus styles (`outline-none focus-visible:ring focus-visible:ring-ring/50`) alongside hover states. This applies to UI primitives (like the `link` variant in Buttons/Badges) and custom text buttons.
